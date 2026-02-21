#!/usr/bin/env python3
"""
MCP Server Compiler

Main orchestrator that:
1. Spawns servers via Runtime API to discover tools
2. Cleans metadata using LLM based on ACTUAL tool information
3. Retries failed servers with different transports
4. Runs in parallel with 3 models assigned to different batches
5. Writes to mcpCompiled.json with checkpointing

Usage:
    python compiler.py [--phase 1|2|all] [--limit N] [--workers N] [--resume]
"""

import json
import os
import sys
import time
import argparse
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, asdict, field
import requests
from tqdm import tqdm
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

load_dotenv()

SCRIPT_DIR = Path(__file__).parent.absolute()
DATA_DIR = SCRIPT_DIR.parent.parent / "data"
OUTPUT_DIR = SCRIPT_DIR / "output"

REGISTRY_REFINED_PATH = DATA_DIR / "registryRefined.json"
MCPCOMPILED_PATH = OUTPUT_DIR / "mcpCompiled.json"
FAILEDSERVERS_PATH = OUTPUT_DIR / "failedServers.json"
PROGRESS_PATH = OUTPUT_DIR / "progress.json"

CONNECTOR_URL = os.environ.get(
    "CONNECTOR_URL", "https://services.compose.market/connector"
)
RUNTIME_URL = os.environ.get("RUNTIME_URL", "https://runtime.compose.market")
MANOWAR_INTERNAL_SECRET = os.environ.get("MANOWAR_INTERNAL_SECRET", "")

CHECKPOINT_INTERVAL = 15
SPAWN_TIMEOUT = 90  # Match Runtime's 60s + buffer
BATCH_SIZE = 100
NUM_MODELS = 3

TRANSPORT_PRIORITY = ["npx", "stdio", "http", "docker"]

# Thread-safe locks
compiled_lock = threading.Lock()
failed_lock = threading.Lock()
progress_lock = threading.Lock()


@dataclass
class Progress:
    phase: int = 1
    processed: int = 0
    total: int = 0
    last_processed_id: str = ""
    started_at: str = ""
    updated_at: str = ""
    success_count: int = 0
    failed_count: int = 0
    retry_count: int = 0

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict):
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class CompiledServer:
    id: str
    registryId: str
    name: str
    slug: str
    description: str
    tags: list
    transport: str = ""
    tools: list = field(default_factory=list)
    tool_count: int = 0
    spawn: dict = field(default_factory=dict)
    source: str = ""
    compiled_at: str = ""
    working_transport: str = ""
    spawn_failed: bool = False
    vars_required: dict = field(default_factory=dict)

    def to_dict(self):
        d = {}
        for k, v in asdict(self).items():
            if v or k in [
                "id",
                "registryId",
                "name",
                "description",
                "tags",
                "spawn_failed",
            ]:
                d[k] = v
        return d


@dataclass
class FailedServer:
    id: str
    registryId: str
    name: str
    description: str = ""
    tags: list = field(default_factory=list)
    error: str = ""
    error_code: str = ""
    transports_tried: list = field(default_factory=list)
    failed_at: str = ""
    retryable: bool = True

    def to_dict(self):
        return asdict(self)


def detect_required_vars(error_msg: str) -> Dict[str, str]:
    """Extract vars_needed from Runtime error message.

    The Runtime already tells us what vars are needed, e.g.:
    'Server "mcp:x" requires credentials: API_KEY. Add your API key...'
    'Server "mcp:y" requires credentials: NOTION_API_KEY. Add...'
    """
    vars_required = {}

    # Pattern 1: "requires credentials: VAR_NAME"
    match = re.search(r"requires credentials:\s*([A-Z_][A-Z0-9_]+)", error_msg)
    if match:
        var_name = match.group(1)
        vars_required[var_name] = f"Required: {var_name}"
        return vars_required

    # Pattern 2: "environment variable required: VAR_NAME" or "VAR_NAME environment variable required"
    match = re.search(
        r"([A-Z_][A-Z0-9_]{2,})\s*(?:environment variable required|env.*required)",
        error_msg,
        re.IGNORECASE,
    )
    if match:
        var_name = match.group(1).upper()
        vars_required[var_name] = f"Required: {var_name}"
        return vars_required

    # Pattern 3: Any explicit env var mention
    matches = re.findall(r"\b([A-Z_][A-Z0-9_]{3,})\b", error_msg)
    for var_name in matches:
        if var_name not in (
            "SERVER",
            "ERROR",
            "FAILED",
            "TIMEOUT",
            "SESSION",
            "ID",
            "MCP",
            "API",
        ):
            vars_required[var_name] = f"Required: {var_name}"

    return vars_required


def get_spawn_configs(server: dict) -> List[Dict[str, Any]]:
    """Get all possible spawn configurations for a server, ordered by priority."""
    configs = []
    raw = server.get("raw", server)

    packages = raw.get("packages", [])

    # NPX transport
    if packages:
        for pkg in packages:
            spawn = pkg.get("spawn", {})
            if spawn and spawn.get("command") == "npx":
                package_name = (
                    spawn.get("args", [""])[-1]
                    if spawn.get("args")
                    else pkg.get("identifier")
                )
                configs.append(
                    {
                        "transport": "npx",
                        "package": package_name,
                        "args": spawn.get("args", []),
                        "env": spawn.get("env", {}),
                    }
                )
                break
            elif pkg.get("registryType") == "npm":
                configs.append(
                    {
                        "transport": "npx",
                        "package": pkg.get("identifier"),
                        "env": {},
                    }
                )
                break
            elif pkg.get("registryType") == "pypi":
                pkg_id = pkg.get("identifier", "")
                configs.append(
                    {
                        "transport": "stdio",
                        "command": "uvx",
                        "args": [
                            "--from",
                            pkg_id,
                            pkg_id.split("/")[-1] if "/" in pkg_id else pkg_id,
                        ],
                        "env": {},
                    }
                )
                break

    # HTTP transport from remotes
    remotes = raw.get("remotes", [])
    if remotes:
        for remote in remotes:
            url = remote.get("url", "")
            if url and not any(
                p in url.lower()
                for p in ["localhost", "127.0.0.1", "your-", "example.com", "0.0.0.0"]
            ):
                configs.append(
                    {
                        "transport": "http",
                        "remoteUrl": url,
                        "protocol": remote.get("type", "sse"),
                    }
                )

    # HTTP from remoteUrl
    remote_url = raw.get("remoteUrl") or server.get("remoteUrl")
    if remote_url and not any(
        p in remote_url.lower()
        for p in ["localhost", "127.0.0.1", "your-", "example.com", "0.0.0.0"]
    ):
        configs.append(
            {
                "transport": "http",
                "remoteUrl": remote_url,
                "protocol": "sse",
            }
        )

    # Docker transport
    image = raw.get("image") or server.get("image")
    if image:
        configs.append(
            {
                "transport": "docker",
                "image": image,
            }
        )

    # Deduplicate by transport type
    seen = set()
    unique_configs = []
    for c in configs:
        t = c.get("transport")
        if t not in seen:
            seen.add(t)
            unique_configs.append(c)

    # Sort by priority
    def sort_key(c):
        t = c.get("transport", "")
        try:
            return TRANSPORT_PRIORITY.index(t)
        except ValueError:
            return len(TRANSPORT_PRIORITY)

    unique_configs.sort(key=sort_key)
    return unique_configs


def spawn_server_via_runtime(
    server_id: str, config: Optional[Dict] = None
) -> Dict[str, Any]:
    """Spawn server via Runtime API with optional config override."""
    try:
        url = f"{RUNTIME_URL}/mcp/spawn"
        headers = {"Content-Type": "application/json"}

        if MANOWAR_INTERNAL_SECRET:
            headers["x-manowar-internal"] = MANOWAR_INTERNAL_SECRET

        payload: Dict[str, Any] = {"serverId": server_id}
        if config:
            payload["config"] = config

        response = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=SPAWN_TIMEOUT,
        )

        if response.status_code == 200:
            data = response.json()
            tools = data.get("tools", [])
            return {
                "success": True,
                "sessionId": data.get("sessionId"),
                "tools": tools,
                "transport": config.get("transport")
                if config
                else data.get("transport", "unknown"),
            }
        else:
            error_data = response.json()
            if isinstance(error_data.get("error"), dict):
                error_code = error_data["error"].get("code", "")
                error_msg = error_data["error"].get("message", response.text)
            else:
                error_code = ""
                error_msg = str(error_data.get("error", response.text))
            return {
                "success": False,
                "error": error_msg,
                "error_code": error_code,
                "tools": [],
            }

    except requests.Timeout:
        return {
            "success": False,
            "error": f"Spawn timeout ({SPAWN_TIMEOUT}s)",
            "error_code": "TIMEOUT",
            "tools": [],
        }
    except requests.RequestException as e:
        return {
            "success": False,
            "error": str(e),
            "error_code": "REQUEST_ERROR",
            "tools": [],
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "error_code": "UNKNOWN",
            "tools": [],
        }


def process_server_with_model(
    args: Tuple,
) -> Tuple[Optional[dict], Optional[dict], bool, str]:
    """Process a single server with assigned model. Thread-safe."""
    server, model_idx, backends = args

    from llm_service import LLMService

    registry_id = server.get("registryId", "")
    original_name = server.get("name", "")
    namespace = server.get("namespace", "")
    original_desc = server.get("description", "")
    repo_url = server.get("repoUrl", "")

    backend = backends[model_idx % len(backends)]
    llm = LLMService(backend["model"])

    spawn_configs = get_spawn_configs(server)

    transports_tried = []
    last_error = ""
    last_error_code = ""

    for config in spawn_configs:
        transport = config.get("transport", "")
        transports_tried.append(transport)

        result = spawn_server_via_runtime(registry_id, config)

        if result.get("success") and result.get("tools"):
            tools = result.get("tools", [])

            llm_result = llm.clean_server_with_tools(
                registry_id, original_name, namespace, repo_url, tools, backend
            )

            if llm_result:
                compiled = CompiledServer(
                    id=registry_id,
                    registryId=registry_id,
                    name=llm_result.name,
                    slug=server.get("slug", ""),
                    description=llm_result.description,
                    tags=llm_result.tags,
                    transport=transport,
                    tools=tools,
                    tool_count=len(tools),
                    spawn=config,
                    source=server.get("source", ""),
                    compiled_at=datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    working_transport=transport,
                    spawn_failed=False,
                )
                return (
                    compiled.to_dict(),
                    None,
                    True,
                    f"SUCCESS ({transport}): {len(tools)} tools",
                )

        error_msg = result.get("error", "")
        error_code = result.get("error_code", "")
        last_error = error_msg
        last_error_code = error_code

        vars_required = detect_required_vars(error_msg)

        if vars_required:
            llm_result = llm.clean_server_from_repo(
                registry_id, original_name, namespace, repo_url, original_desc, backend
            )

            if llm_result:
                compiled = CompiledServer(
                    id=registry_id,
                    registryId=registry_id,
                    name=llm_result.name,
                    slug=server.get("slug", ""),
                    description=llm_result.description,
                    tags=llm_result.tags,
                    transport=transport,
                    tools=[],
                    tool_count=0,
                    spawn=config,
                    source=server.get("source", ""),
                    compiled_at=datetime.now(timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    working_transport=transport,
                    spawn_failed=True,
                    vars_required=vars_required,
                )
                return (
                    compiled.to_dict(),
                    None,
                    True,
                    f"CREDENTIALS ({transport}): {list(vars_required.keys())}",
                )

    # All transports failed - generate metadata for failed entry
    llm_result = llm.clean_server_from_repo(
        registry_id, original_name, namespace, repo_url, original_desc, backend
    )

    name = llm_result.name if llm_result else original_name
    description = llm_result.description if llm_result else original_desc
    tags = llm_result.tags if llm_result else []

    failed = FailedServer(
        id=registry_id,
        registryId=registry_id,
        name=name,
        description=description,
        tags=tags,
        error=last_error,
        error_code=last_error_code,
        transports_tried=transports_tried,
        failed_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        retryable=False,
    )
    return (None, failed.to_dict(), False, f"FAILED: {last_error_code}")


class MCPCompiler:
    def __init__(self):
        from llm_service import LLMService

        self.llm = LLMService()
        self.servers = []
        self.compiled: Dict[str, dict] = {}
        self.failed: Dict[str, dict] = {}
        self.progress = Progress()
        self.backends = self.llm.get_available_backends()

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        existing = self.load_compiled()
        if existing:
            self.compiled = existing
            print(f"[Compiler] Loaded {len(existing)} existing compiled servers")

    def load_servers(self) -> list:
        print(f"[Compiler] Loading servers from {REGISTRY_REFINED_PATH}")
        with open(REGISTRY_REFINED_PATH) as f:
            data = json.load(f)

        self.servers = data if isinstance(data, list) else data.get("servers", [])
        self.servers = [s for s in self.servers if s.get("origin") == "mcp"]

        print(f"[Compiler] Loaded {len(self.servers)} MCP servers")
        return self.servers

    def load_progress(self) -> Optional[Progress]:
        if PROGRESS_PATH.exists():
            with open(PROGRESS_PATH) as f:
                data = json.load(f)
            return Progress.from_dict(data)
        return None

    def save_progress(self):
        with progress_lock:
            self.progress.updated_at = (
                datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            with open(PROGRESS_PATH, "w") as f:
                json.dump(self.progress.to_dict(), f, indent=2)

    def load_compiled(self) -> dict:
        if MCPCOMPILED_PATH.exists():
            with open(MCPCOMPILED_PATH) as f:
                data = json.load(f)
            return {s["id"]: s for s in data.get("servers", [])}
        return {}

    def save_compiled(self):
        with compiled_lock:
            servers = list(self.compiled.values())
            output = {
                "compiledAt": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
                "totalCount": len(servers),
                "successCount": self.progress.success_count,
                "failedCount": len(self.failed),
                "retryCount": self.progress.retry_count,
                "servers": servers,
            }
            with open(MCPCOMPILED_PATH, "w") as f:
                json.dump(output, f, indent=2)

    def save_failed(self):
        with failed_lock:
            servers = list(self.failed.values())
            output = {
                "failedAt": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
                "totalCount": len(servers),
                "servers": servers,
            }
            with open(FAILEDSERVERS_PATH, "w") as f:
                json.dump(output, f, indent=2)

    def cleanup_output(self):
        for p in [MCPCOMPILED_PATH, FAILEDSERVERS_PATH, PROGRESS_PATH]:
            if p.exists():
                p.unlink()
        self.compiled = {}
        self.failed = {}
        print("[Compiler] Cleaned up output files")

    def run_phase1(
        self, limit: Optional[int] = None, resume: bool = False, workers: int = 3
    ):
        """Phase 1: Parallel processing with 3 models assigned round-robin."""
        print("\n" + "=" * 60)
        print("PHASE 1: Tool Discovery & Metadata Generation (Parallel)")
        print("=" * 60)

        if resume:
            progress = self.load_progress()
            if progress:
                self.progress = progress
                print(f"[Phase 1] Resuming from: {self.progress.last_processed_id}")

        servers_to_process = self.servers

        if resume and self.progress.last_processed_id:
            start_idx = (
                next(
                    (
                        i
                        for i, s in enumerate(servers_to_process)
                        if s.get("registryId") == self.progress.last_processed_id
                    ),
                    0,
                )
                + 1
            )
            servers_to_process = servers_to_process[start_idx:]

        if limit:
            servers_to_process = servers_to_process[:limit]

        servers_to_process = [
            s for s in servers_to_process if s.get("registryId") not in self.compiled
        ]

        self.progress.total = len(self.servers)
        self.progress.phase = 1
        if not self.progress.started_at:
            self.progress.started_at = (
                datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )

        num_models = len(self.backends)
        already_compiled = len(self.compiled)

        print(f"[Phase 1] {len(servers_to_process)} servers to process")
        if already_compiled > 0:
            print(f"[Phase 1] {already_compiled} already compiled (skipped)")
        print(f"[Phase 1] {num_models} models in parallel")
        for i, b in enumerate(self.backends):
            print(
                f"  - Model {i + 1}: {b['model']} (servers {i}::{i + num_models}::{i + 2 * num_models}...)"
            )
        print(f"[Phase 1] Connector: {CONNECTOR_URL}")
        print(f"[Phase 1] Runtime: {RUNTIME_URL}")

        if not servers_to_process:
            print("[Phase 1] No servers to process")
            return

        # Prepare args for parallel processing
        # Assign model based on index: model_idx = index % num_models
        process_args = [
            (server, idx % num_models, self.backends)
            for idx, server in enumerate(servers_to_process)
        ]

        processed = 0
        checkpoint_counter = 0

        with ThreadPoolExecutor(max_workers=num_models) as executor:
            futures = {
                executor.submit(process_server_with_model, arg): arg[0]
                for arg in process_args
            }

            with tqdm(total=len(servers_to_process), desc="Processing servers") as pbar:
                for future in as_completed(futures):
                    server = futures[future]
                    registry_id = server.get("registryId")

                    try:
                        compiled, failed, success, msg = future.result()

                        if compiled:
                            with compiled_lock:
                                self.compiled[registry_id] = compiled
                            if success and not compiled.get("vars_required"):
                                with progress_lock:
                                    self.progress.success_count += 1
                                pbar.write(f"[OK] {registry_id}: {msg}")
                            else:
                                with progress_lock:
                                    self.progress.failed_count += 1
                                pbar.write(f"[CRED] {registry_id}: {msg}")

                        if failed:
                            with failed_lock:
                                self.failed[registry_id] = failed
                            with progress_lock:
                                self.progress.failed_count += 1
                            pbar.write(f"[FAIL] {registry_id}: {msg}")

                        with progress_lock:
                            self.progress.processed += 1
                            self.progress.last_processed_id = registry_id

                        processed += 1
                        checkpoint_counter += 1
                        pbar.set_postfix(
                            {
                                "ok": self.progress.success_count,
                                "fail": len(self.failed),
                            }
                        )
                        pbar.update(1)

                        if checkpoint_counter >= CHECKPOINT_INTERVAL:
                            self.save_progress()
                            self.save_compiled()
                            self.save_failed()
                            checkpoint_counter = 0

                    except Exception as e:
                        pbar.write(f"[{registry_id}] ERROR: {e}")
                        with progress_lock:
                            self.progress.processed += 1

        self.save_progress()
        self.save_compiled()
        self.save_failed()

        print(
            f"\n[Phase 1] Complete: {self.progress.success_count} with tools, "
            f"{len(self.failed)} failed"
        )

    def run_phase2(self, limit: Optional[int] = None):
        """Phase 2: Retry failed servers."""
        print("\n" + "=" * 60)
        print("PHASE 2: Retry Failed Servers")
        print("=" * 60)

        servers_to_retry = []
        for server in self.servers:
            registry_id = server.get("registryId")
            if registry_id in self.failed:
                failed = self.failed[registry_id]
                if failed.get("retryable", True):
                    servers_to_retry.append(server)

        if limit:
            servers_to_retry = servers_to_retry[:limit]

        print(f"[Phase 2] {len(servers_to_retry)} servers to retry")

        if not servers_to_retry:
            print("[Phase 2] No servers to retry")
            return

        num_models = len(self.backends)

        # Remove from failed before retry
        for server in servers_to_retry:
            registry_id = server.get("registryId")
            if registry_id in self.failed:
                del self.failed[registry_id]

        process_args = [
            (server, idx % num_models, self.backends)
            for idx, server in enumerate(servers_to_retry)
        ]

        retry_success = 0

        with ThreadPoolExecutor(max_workers=num_models) as executor:
            futures = {
                executor.submit(process_server_with_model, arg): arg[0]
                for arg in process_args
            }

            with tqdm(total=len(servers_to_retry), desc="Retrying servers") as pbar:
                for future in as_completed(futures):
                    server = futures[future]
                    registry_id = server.get("registryId")

                    try:
                        compiled, failed, success, msg = future.result()

                        if compiled:
                            with compiled_lock:
                                self.compiled[registry_id] = compiled
                            if success and not compiled.get("vars_required"):
                                with progress_lock:
                                    self.progress.success_count += 1
                                    self.progress.retry_count += 1
                                    retry_success += 1
                                pbar.write(f"[{registry_id}] RETRY SUCCESS")
                            else:
                                with progress_lock:
                                    self.progress.failed_count += 1

                        if failed:
                            failed["retryable"] = False
                            with failed_lock:
                                self.failed[registry_id] = failed

                        pbar.update(1)

                    except Exception as e:
                        pbar.write(f"[{registry_id}] RETRY ERROR: {e}")

        self.save_compiled()
        self.save_failed()

        print(f"\n[Phase 2] Complete: {retry_success} retries succeeded")

    def run_all(
        self, limit: Optional[int] = None, resume: bool = False, workers: int = 3
    ):
        self.run_phase1(limit, resume, workers)
        self.run_phase2(limit)

        print("\n" + "=" * 60)
        print("COMPILATION COMPLETE")
        print("=" * 60)
        print(f"Total servers processed: {self.progress.processed}")
        print(f"Successfully compiled: {len(self.compiled)}")
        print(f"  - With tools: {self.progress.success_count}")
        print(
            f"  - Need credentials: {len(self.compiled) - self.progress.success_count}"
        )
        print(f"Failed (not included): {len(self.failed)}")
        print(f"Output: {MCPCOMPILED_PATH}")
        print(f"Failed: {FAILEDSERVERS_PATH}")


def main():
    parser = argparse.ArgumentParser(description="MCP Server Compiler")
    parser.add_argument(
        "--phase",
        type=int,
        choices=[1, 2],
        default=None,
        help="Run specific phase (1=spawn+metadata, 2=retry failed)",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of servers to process"
    )
    parser.add_argument(
        "--start", type=int, default=0, help="Start index in server list"
    )
    parser.add_argument(
        "--resume", action="store_true", help="Resume from last checkpoint"
    )
    parser.add_argument(
        "--workers", type=int, default=3, help="Number of parallel models"
    )
    parser.add_argument(
        "--test", action="store_true", help="Run test mode (10 servers)"
    )
    args = parser.parse_args()

    compiler = MCPCompiler()
    compiler.load_servers()

    if args.start > 0:
        compiler.servers = compiler.servers[args.start :]
        print(
            f"[Compiler] Starting from index {args.start}, {len(compiler.servers)} servers remaining"
        )

    limit = args.limit or (10 if args.test else None)

    if args.phase == 1:
        compiler.run_phase1(limit, args.resume, args.workers)
    elif args.phase == 2:
        compiler.run_phase2(limit)
    else:
        compiler.run_all(limit, args.resume, args.workers)


if __name__ == "__main__":
    main()
