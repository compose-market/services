#!/usr/bin/env python3
"""
LLM Service for MCP Server Metadata Cleaning

Uses ASI:Cloud OpenAI-compatible inference API.
Generates metadata based on ACTUAL tool information from spawned servers.
"""

import json
import os
import time
import random
import re
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from openai import OpenAI, APIError, RateLimitError, APITimeoutError
from dotenv import load_dotenv

load_dotenv()

ASI_BASE_URL = "https://inference.asicloud.cudos.org/v1"
ASI_API_KEY = os.environ.get("ASI_INFERENCE_API_KEY")

MAX_RETRIES = 3
BASE_RETRY_DELAY = 1.0
MAX_RETRY_DELAY = 10.0


@dataclass
class CleanedMetadata:
    name: str
    description: str
    tags: list[str]


class LLMService:
    BANNED_TAGS = {
        "mcp",
        "server",
        "tool",
        "api",
        "client",
        "wrapper",
        "helper",
        "utility",
        "utilities",
    }

    VALID_TAGS = [
        "filesystem",
        "database",
        "git",
        "github",
        "gitlab",
        "slack",
        "discord",
        "web3",
        "ai",
        "search",
        "rag",
        "embeddings",
        "llm",
        "machine-learning",
        "postgresql",
        "mysql",
        "mongodb",
        "redis",
        "elasticsearch",
        "sqlite",
        "email",
        "calendar",
        "crm",
        "analytics",
        "monitoring",
        "logging",
        "authentication",
        "security",
        "encryption",
        "payment",
        "billing",
        "storage",
        "backup",
        "deployment",
        "docker",
        "kubernetes",
        "testing",
        "automation",
        "scheduling",
        "workflow",
        "orchestration",
        "chat",
        "messaging",
        "notification",
        "sms",
        "voice",
        "video",
        "document",
        "pdf",
        "excel",
        "csv",
        "json",
        "markdown",
        "image",
        "video-processing",
        "audio",
        "media",
        "ocr",
        "nlp",
        "translation",
        "sentiment",
        "speech-recognition",
        "blockchain",
        "crypto",
        "defi",
        "nft",
        "smart-contracts",
        "e-commerce",
        "inventory",
        "orders",
        "shipping",
        "healthcare",
        "finance",
        "legal",
        "education",
        "travel",
        "food",
        "recipes",
        "cocktails",
        "entertainment",
        "gaming",
        "weather",
        "maps",
        "geolocation",
        "transportation",
        "social-media",
        "content",
        "marketing",
        "seo",
        "knowledge-base",
        "wiki",
        "documentation",
        "browser",
        "web-scraping",
        "desktop",
        "google",
        "microsoft",
        "aws",
        "azure",
        "gcp",
        "twitter",
        "linkedin",
        "instagram",
        "youtube",
        "reddit",
        "jira",
        "linear",
        "notion",
        "confluence",
        "asana",
        "figma",
        "design",
        "shell",
        "terminal",
        "memory",
        "vector-store",
        "qdrant",
        "pinecone",
        "weaviate",
        "webhook",
        "http",
        "rest",
        "graphql",
        "puppeteer",
        "playwright",
    ]

    BACKENDS = [
        {
            "provider": "qwen",
            "model": "qwen/qwen3-32b",
            "fallback": "meta-llama/llama-3.3-70b-instruct",
        },
        {
            "provider": "nousresearch",
            "model": "nousresearch/hermes-4-70b",
            "fallback": "meta-llama/llama-3.3-70b-instruct",
        },
        {
            "provider": "minimax",
            "model": "minimax/minimax-m2.1",
            "fallback": "qwen/qwen3-32b",
        },
    ]

    def __init__(self, backend_name: Optional[str] = None):
        self.backend = self._select_backend(backend_name)
        self.client = OpenAI(
            api_key=ASI_API_KEY,
            base_url=ASI_BASE_URL,
            timeout=30.0,
            max_retries=2,
        )

    def _select_backend(self, name: Optional[str] = None) -> Dict[str, str]:
        for b in self.BACKENDS:
            if name and b["model"] == name:
                return b
        return self.BACKENDS[0]

    def get_available_backends(self) -> List[Dict[str, str]]:
        return list(self.BACKENDS)

    def _build_prompt_from_tools(
        self,
        server_id: str,
        original_name: str,
        namespace: str,
        repo_url: str,
        tools: List[Dict[str, Any]],
    ) -> str:
        tools_text = "\n\nDISCOVERED TOOLS (from spawning the server):"
        for i, t in enumerate(tools[:20], 1):
            name = t.get("name", "unknown")
            desc = t.get("description", "")
            if desc:
                tools_text += f"\n{i}. {name}: {desc[:200]}"
            else:
                tools_text += f"\n{i}. {name}"

        prompt = f"""Generate professional metadata for this MCP server based on its ACTUAL tools.

SERVER INFO:
- Original Name: "{original_name}"
- Author: {namespace}
- Repository: {repo_url}{tools_text}

TASK: Create clean metadata that accurately describes what this server does based on the tools above.

RULES:

1. NAME (2-6 words, Title Case):
   - Remove: "MCP", "Server", "by [author]", "| Glama", "| PulseMCP"
   - Describe the core functionality based on tools
   - Examples: "GitHub Repository Access", "PostgreSQL Query Engine", "Echo Testing Utilities"

2. DESCRIPTION (2 sentences, max 200 chars):
   - MUST be based on what the tools actually do
   - First sentence: primary capability
   - Second sentence: key features
   - Be specific and accurate

3. TAGS (2-4 specific lowercase tags):
   - FORBIDDEN: mcp, server, tool, api, client, wrapper, helper, utility
   - Choose tags that match the domain/functionality of the tools
   - Available tags: {", ".join(self.VALID_TAGS[:30])}
   - Or create appropriate domain-specific tags

Return ONLY valid JSON (no markdown):
{{"name": "Name", "description": "Sentence one. Sentence two.", "tags": ["tag1", "tag2"]}}"""

        return prompt

    def _build_prompt_from_repo(
        self,
        server_id: str,
        original_name: str,
        namespace: str,
        repo_url: str,
        original_desc: str,
    ) -> str:
        clean_name = original_name
        for phrase in ["MCP Server", "MCP", "Server", "| Glama", "| PulseMCP"]:
            clean_name = re.sub(
                rf"\s*{re.escape(phrase)}\s*", " ", clean_name, flags=re.IGNORECASE
            )
        clean_name = re.sub(r"\s+by\s+\S+", "", clean_name, flags=re.IGNORECASE).strip()

        repo_name = ""
        if repo_url:
            parts = repo_url.rstrip("/").split("/")
            repo_name = parts[-1] if parts else ""

        prompt = f"""Generate professional metadata for this software package.

PACKAGE INFO:
- Original Name: "{original_name}"
- Name Hint: "{clean_name}"
- Repository Name: "{repo_name}"
- Author: {namespace}
- Repository: {repo_url}
- Original Description: "{original_desc}"

The server could not be spawned. Infer functionality from the repository name.

RULES:

1. NAME (2-6 words, Title Case):
   - Derive from repository name
   - Example: "cocktails-rag-mcp" -> "Cocktails Recipe Search"
   - Remove: "MCP", "Server", "-mcp" suffix

2. DESCRIPTION (2 sentences, max 200 chars):
   - Infer from repo name structure
   - Be specific about likely functionality

3. TAGS (2-4 specific lowercase tags):
   - FORBIDDEN: mcp, server, tool, api, client, wrapper, helper, utility
   - Infer from repository name
   - Example: "cocktails-rag-mcp" -> ["recipes", "search", "food"]

Return ONLY valid JSON:
{{"name": "Name", "description": "Sentence one. Sentence two.", "tags": ["tag1", "tag2"]}}"""

        return prompt

    def _call_llm(
        self, prompt: str, backend: Dict[str, str]
    ) -> Optional[Dict[str, Any]]:
        model = backend["model"]
        fallback_model = backend.get("fallback")
        is_reasoning_model = "minimax" in model or "m2.1" in model

        for attempt in range(MAX_RETRIES):
            try:
                max_tokens = 2048 if is_reasoning_model else 600

                response = self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a JSON metadata generator. Output ONLY valid JSON, no thinking, no markdown, no explanation. Start with {",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.1,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                )

                content = response.choices[0].message.content
                if content:
                    return self._parse_json_response(content, is_reasoning_model)
                return None

            except RateLimitError:
                delay = min(
                    BASE_RETRY_DELAY * (2**attempt) + random.uniform(0, 1),
                    MAX_RETRY_DELAY,
                )
                print(f"[LLM] Rate limited on {model}, retrying in {delay:.1f}s...")
                time.sleep(delay)

            except APITimeoutError:
                print(f"[LLM] Timeout on {model}, attempt {attempt + 1}/{MAX_RETRIES}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BASE_RETRY_DELAY)

            except APIError as e:
                print(f"[LLM] API error on {model}: {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(BASE_RETRY_DELAY)

            except Exception as e:
                if "Connection error" in str(e) or "connection" in str(e).lower():
                    if fallback_model and model != fallback_model:
                        print(
                            f"[LLM] Connection error on {model}, trying fallback {fallback_model}"
                        )
                        model = fallback_model
                        continue
                print(f"[LLM] Unexpected error on {model}: {e}")
                break

        if fallback_model and model != fallback_model:
            print(f"[LLM] All retries failed, trying fallback {fallback_model}")
            try:
                response = self.client.chat.completions.create(
                    model=fallback_model,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a JSON metadata generator. Output ONLY valid JSON.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.1,
                    max_tokens=600,
                    response_format={"type": "json_object"},
                )
                content = response.choices[0].message.content
                if content:
                    return self._parse_json_response(content, False)
            except Exception as e:
                print(f"[LLM] Fallback {fallback_model} also failed: {e}")

        return None

    def _parse_json_response(
        self, content: str, is_reasoning_model: bool = False
    ) -> Optional[Dict[str, Any]]:
        try:
            content = content.strip()

            if is_reasoning_model:
                content = re.sub(r"^.*?(\{)", r"\1", content, flags=re.DOTALL)

            if "```" in content:
                lines = content.split("\n")
                code_content = []
                in_code = False
                for line in lines:
                    if line.strip().startswith("```"):
                        in_code = not in_code
                        continue
                    if in_code:
                        code_content.append(line)
                if code_content:
                    content = "\n".join(code_content)

            start = content.find("{")
            end = content.rfind("}") + 1
            if start != -1 and end > start:
                content = content[start:end]

            data = json.loads(content)

            if not isinstance(data, dict):
                return None
            if "name" not in data or "description" not in data or "tags" not in data:
                return None
            if not isinstance(data["tags"], list):
                return None

            name = str(data["name"]).strip()
            for phrase in ["MCP Server", "MCP", "Server", "| Glama", "| PulseMCP"]:
                name = re.sub(
                    rf"\s*{re.escape(phrase)}\s*", " ", name, flags=re.IGNORECASE
                )
            name = re.sub(r"\s+by\s+\S+", "", name, flags=re.IGNORECASE)
            name = " ".join(name.split()).strip()
            if len(name) < 3:
                return None
            name = name[:60]

            desc = str(data["description"]).strip()
            desc = re.sub(r"^MCP server:\s*", "", desc, flags=re.IGNORECASE)
            desc = re.sub(r"\s+", " ", desc).strip()
            if len(desc) < 20:
                return None
            desc = desc[:200]

            tags = []
            for t in data["tags"][:5]:
                tag = str(t).lower().strip()[:25]
                tag = re.sub(r"[^a-z0-9-]", "-", tag).strip("-")
                if tag and tag not in self.BANNED_TAGS and len(tag) >= 2:
                    tags.append(tag)

            if len(tags) < 2:
                return None

            return {
                "name": name,
                "description": desc,
                "tags": tags[:4],
            }
        except json.JSONDecodeError:
            return None
        except Exception:
            return None

    def clean_server_with_tools(
        self,
        server_id: str,
        original_name: str,
        namespace: str,
        repo_url: str,
        tools: List[Dict[str, Any]],
        backend: Optional[Dict[str, str]] = None,
    ) -> Optional[CleanedMetadata]:
        prompt = self._build_prompt_from_tools(
            server_id, original_name, namespace, repo_url, tools
        )
        b = backend or self.backend
        result = self._call_llm(prompt, b)
        if result:
            return CleanedMetadata(**result)
        return None

    def clean_server_from_repo(
        self,
        server_id: str,
        original_name: str,
        namespace: str,
        repo_url: str,
        original_desc: str,
        backend: Optional[Dict[str, str]] = None,
    ) -> Optional[CleanedMetadata]:
        prompt = self._build_prompt_from_repo(
            server_id, original_name, namespace, repo_url, original_desc
        )
        b = backend or self.backend
        result = self._call_llm(prompt, b)
        if result:
            return CleanedMetadata(**result)
        return None

    def clean_server(
        self, server_data: dict, backend: Optional[Dict[str, str]] = None
    ) -> Optional[CleanedMetadata]:
        server_id = server_data.get("id", server_data.get("registryId", "unknown"))
        original_name = server_data.get("name", "")
        namespace = server_data.get("namespace", "")

        repo_url = ""
        repo = server_data.get("repository")
        if repo:
            if isinstance(repo, dict):
                repo_url = repo.get("url", "")
            else:
                repo_url = str(repo)

        original_desc = server_data.get("description", "")
        tools = server_data.get("tools", [])

        if tools and len(tools) > 0:
            return self.clean_server_with_tools(
                server_id, original_name, namespace, repo_url, tools, backend
            )
        else:
            return self.clean_server_from_repo(
                server_id, original_name, namespace, repo_url, original_desc, backend
            )


def clean_server_worker(args):
    server_data, backend = args
    service = LLMService(backend["model"])
    result = service.clean_server(server_data, backend)
    if result:
        return {
            "success": True,
            "name": result.name,
            "description": result.description,
            "tags": result.tags,
        }
    return {"success": False}


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python llm_service.py <server_json> [backend]")
        sys.exit(1)

    backend = sys.argv[2] if len(sys.argv) > 2 else None
    service = LLMService(backend)
    server = json.loads(sys.argv[1])
    result = service.clean_server(server)
    if result:
        print(
            json.dumps(
                {
                    "success": True,
                    "name": result.name,
                    "description": result.description,
                    "tags": result.tags,
                }
            )
        )
    else:
        print(json.dumps({"success": False}))
