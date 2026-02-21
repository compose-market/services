#!/usr/bin/env python3
"""
Model Metadata Compiler

Orchestrates the independent pipeline to compile extensive metadata for
all AI models cataloged in models_extended.json. Uses local LLMs with
web search tools to verify exact context windows and pricing data.
"""

import json
import os
from pathlib import Path
from multiprocessing import Pool
from datetime import datetime
from tqdm import tqdm
import argparse
import sys

from llm_service import ToolCallingLLMService, compile_model_worker

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent.parent.parent.parent / "lambda" / "shared" / "models" / "data"

MODELS_EXTENDED_PATH = DATA_DIR / "models_extended.json"
COMPILED_OUTPUT_PATH = SCRIPT_DIR / "compiled_models.json"
FAILED_OUTPUT_PATH = SCRIPT_DIR / "failed_models.json"
PROGRESS_PATH = SCRIPT_DIR / "progress.json"

CHECKPOINT_INTERVAL = 50

class ProgressData:
    def __init__(self):
        self.total = 0
        self.processed = 0
        self.success_count = 0
        self.failed_count = 0
        self.last_processed_id = None
        self.started_at = None

class ModelCompiler:
    def __init__(self):
        self.models = []
        self.compiled = {}
        self.failed = {}
        self.progress = ProgressData()
        self.llm = ToolCallingLLMService()
        
    def load_models(self):
        if not MODELS_EXTENDED_PATH.exists():
            print(f"[Error] models_extended.json not found at {MODELS_EXTENDED_PATH}")
            sys.exit(1)
            
        try:
            with open(MODELS_EXTENDED_PATH, "r") as f:
                data = json.load(f)
                self.models = data.get("models", [])
        except json.JSONDecodeError:
            print("[Error] Invalid JSON in models_extended.json")
            sys.exit(1)
            
        print(f"[Compiler] Loaded {len(self.models)} models from source")
        
    def load_progress(self) -> bool:
        """Load checkpoint if exists."""
        if not PROGRESS_PATH.exists():
            return False
            
        try:
            with open(PROGRESS_PATH, "r") as f:
                data = json.load(f)
                self.progress.total = data.get("total", 0)
                self.progress.processed = data.get("processed", 0)
                self.progress.success_count = data.get("successCount", 0)
                self.progress.failed_count = data.get("failedCount", 0)
                self.progress.last_processed_id = data.get("lastProcessedId")
                self.progress.started_at = data.get("startedAt")
                
            if COMPILED_OUTPUT_PATH.exists():
                with open(COMPILED_OUTPUT_PATH, "r") as f:
                    comp_data = json.load(f)
                    for server in comp_data.get("models", []):
                        self.compiled[server["id"]] = server
                        
            if FAILED_OUTPUT_PATH.exists():
                with open(FAILED_OUTPUT_PATH, "r") as f:
                    failed_data = json.load(f)
                    for server in failed_data.get("models", []):
                        self.failed[server["id"]] = server
                        
            print(f"[Compiler] Resumed from checkpoint (Processed: {self.progress.processed})")
            return True
        except Exception as e:
            print(f"[Compiler] Error loading checkpoint: {e}")
            return False

    def save_progress(self):
        with open(PROGRESS_PATH, "w") as f:
            json.dump({
                "total": self.progress.total,
                "processed": self.progress.processed,
                "successCount": self.progress.success_count,
                "failedCount": self.progress.failed_count,
                "lastProcessedId": self.progress.last_processed_id,
                "startedAt": self.progress.started_at,
                "updatedAt": datetime.utcnow().isoformat() + "Z"
            }, f, indent=2)

    def save_compiled(self):
        output = {
            "compiledAt": datetime.utcnow().isoformat() + "Z",
            "totalCount": len(self.compiled),
            "successCount": self.progress.success_count,
            "failedCount": self.progress.failed_count,
            "models": list(self.compiled.values())
        }
        with open(COMPILED_OUTPUT_PATH, "w") as f:
            json.dump(output, f, indent=2)

    def save_failed(self):
        output = {
            "failedAt": datetime.utcnow().isoformat() + "Z",
            "totalCount": len(self.failed),
            "models": list(self.failed.values())
        }
        with open(FAILED_OUTPUT_PATH, "w") as f:
            json.dump(output, f, indent=2)

    def run(self, limit: int = None, resume: bool = False, workers: int = 10):
        print("\n" + "="*60)
        print("MODEL METADATA COMPILATION PIPELINE")
        print("="*60)
        
        if resume:
            self.load_progress()
            
        models_to_process = self.models
        if resume and self.progress.last_processed_id:
            start_idx = next((i for i, s in enumerate(models_to_process) 
                            if s.get("modelId", s.get("id")) == self.progress.last_processed_id), 0) + 1
            models_to_process = models_to_process[start_idx:]
            
        if limit is not None:
            models_to_process = models_to_process[:limit]
            
        # Filter already compiled
        models_to_process = [s for s in models_to_process 
                            if s.get("modelId", s.get("id")) not in self.compiled]
                            
        self.progress.total = len(self.models)
        if not self.progress.started_at:
            self.progress.started_at = datetime.utcnow().isoformat() + "Z"
            
        backends = self.llm.get_available_backends()
        print(f"[Compiler] {len(models_to_process)} models to compile, {len(backends)} backends, {workers} parallel workers")
        
        if not models_to_process:
            print("[Compiler] No models to process")
            return
            
        # Map tasks
        tasks = []
        for i, model in enumerate(models_to_process):
            backend = backends[i % len(backends)]
            tasks.append((model, backend))
            
        # Execute concurrently
        with Pool(processes=workers) as pool:
            with tqdm(total=len(models_to_process), desc="Compiling") as pbar:
                for i, result in enumerate(pool.imap(compile_model_worker, tasks, chunksize=5)):
                    model = models_to_process[i]
                    model_id = model.get("modelId", model.get("id"))
                    
                    if result.get("success"):
                        self.compiled[model_id] = result["data"]
                        self.progress.success_count += 1
                    else:
                        self.failed[model_id] = {
                            "id": model_id,
                            "originalName": model.get("name"),
                            "failedAt": datetime.utcnow().isoformat() + "Z"
                        }
                        self.progress.failed_count += 1
                        
                    self.progress.processed += 1
                    self.progress.last_processed_id = model_id
                    pbar.update(1)
                    
                    if self.progress.processed % CHECKPOINT_INTERVAL == 0:
                        self.save_progress()
                        self.save_compiled()
                        self.save_failed()

        self.save_progress()
        self.save_compiled()
        self.save_failed()
        
        print("\n" + "="*60)
        print("COMPILATION COMPLETE")
        print(f"Successfully compiled: {len(self.compiled)}")
        print(f"Failed: {len(self.failed)}")
        print(f"Output: {COMPILED_OUTPUT_PATH}")

def main():
    parser = argparse.ArgumentParser(description="Independent Model Metadata Compiler")
    parser.add_argument("--limit", type=int, default=None, help="Limit number to process")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    parser.add_argument("--workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--test", action="store_true", help="Run in test mode (5 models)")
    
    args = parser.parse_args()
    
    compiler = ModelCompiler()
    compiler.load_models()
    
    limit = args.limit or (5 if args.test else None)
    compiler.run(limit=limit, resume=args.resume, workers=args.workers)

if __name__ == "__main__":
    main()
