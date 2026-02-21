#!/usr/bin/env python3
"""
Independent LLM Service for Model Metadata Compilation

Connects directly to local Ollama (Qwen/Nemotron) to enrich model metadata
by actively searching the web for exact pricing and context window details.
"""

import json
import os
import time
import urllib.request
import urllib.parse
from html.parser import HTMLParser
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
import requests

EDGE_SERVER = os.environ.get("EDGE_SERVER", "http://localhost:8080")

@dataclass
class CompiledModelInfo:
    id: str
    name: str
    source: str
    ownedBy: str
    task: str
    description: str
    contextLength: int
    maxOutputTokens: int
    pricing: dict
    capabilities: list[str]
    inputModalities: list[str]
    outputModalities: list[str]

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []
        self.in_script_or_style = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.in_script_or_style = True

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.in_script_or_style = False

    def handle_data(self, data):
        if not self.in_script_or_style:
            text = data.strip()
            if text:
                self.text.append(text)

    def get_text(self):
        return ' '.join(self.text)

def web_search(query: str) -> str:
    """Perform a web search using DuckDuckGo HTML version and extract text snippets."""
    try:
        url = "https://html.duckduckgo.com/html/"
        data = urllib.parse.urlencode({'q': query}).encode('utf-8')
        req = urllib.request.Request(
            url, 
            data=data, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')
            parser = TextExtractor()
            parser.feed(html)
            text = parser.get_text()
            # Try to grab the snippet section roughly based on content density
            return text[:4000] # Return top 4k chars to avoid blowing up context
    except Exception as e:
        return f"Search failed: {str(e)}"

class ToolCallingLLMService:
    BACKENDS = [
        {"provider": "ollama", "model": "qwen", "endpoint": "/ollama/qwen/chat"},
        {
            "provider": "ollama",
            "model": "qwen-14b",
            "endpoint": "/ollama/qwen-14b/chat",
        },
        {"provider": "ollama", "model": "mistral", "endpoint": "/ollama/mistral/chat"},
        {"provider": "ollama", "model": "gemma", "endpoint": "/ollama/gemma/chat"},
        {"provider": "ollama", "model": "llava", "endpoint": "/ollama/llava/chat"},
    ]

    TOOLS = [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Searches the internet for exact information about AI models, pricing (USD per 1M tokens), and context windows.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query (e.g. 'qwen3-32b token pricing context length output limit')"
                        }
                    },
                    "required": ["query"]
                }
            }
        }
    ]

    def __init__(self, backend_name: Optional[str] = None):
        self.server = EDGE_SERVER
        self.backend = self._select_backend(backend_name)

    def _select_backend(self, name: Optional[str] = None) -> Dict[str, str]:
        for b in self.BACKENDS:
            if name and b["model"] == name:
                return b
        return self.BACKENDS[0]

    def get_available_backends(self) -> List[Dict[str, str]]:
        return list(self.BACKENDS)

    def _build_system_prompt(self) -> str:
        return """You are a highly capable AI model data engineering system.
Your job is to compile the EXACT correct parameters for AI models.
You MUST NOT guess. You MUST use the `web_search` tool to find the real values if you are not 100% certain.

You must return a raw JSON object adhering EXACTLY to this schema (ModelInfo):
{
    "id": "model_id",
    "name": "Model Name",
    "source": "provider",
    "ownedBy": "owner",
    "task": "task_type",
    "description": "A 2-4 sentence accurate description of the model",
    "contextLength": 128000, 
    "maxOutputTokens": 4096,
    "pricing": {
        "input": 0.5, // USD per 1M tokens
        "output": 1.5, // USD per 1M tokens
        "provider": "openrouter"
    },
    "capabilities": ["tools", "vision", "streaming", "reasoning"],
    "inputModalities": ["text", "image"],
    "outputModalities": ["text"]
}

Important Rules:
1. Pricing MUST be in USD per 1 Million tokens. If you find $0.0005 per 1k tokens, multiply by 1000 to get $0.50 per 1M.
2. Context window MUST be integer tokens (e.g. 128000, not "128k").
3. Always supply a single valid JSON object as your final message. Don't wrap it in markdown block.
"""

    def _call_ollama_with_tools(self, prompt: str, backend: Dict[str, str]) -> Optional[Dict[str, Any]]:
        url = f"{self.server}{backend['endpoint']}"
        messages = [
            {"role": "system", "content": self._build_system_prompt()},
            {"role": "user", "content": prompt}
        ]

        # Max 3 turns for tool execution
        for _ in range(3):
            payload = {
                "model": backend["model"],
                "messages": messages,
                "tools": self.TOOLS,
                "stream": False,
                "options": {
                    "temperature": 0.1
                }
            }

            try:
                response = requests.post(url, json=payload, timeout=120)
                if response.status_code != 200:
                    print(f"[LLM] Error: Status {response.status_code}")
                    return None
                    
                result = response.json()
                msg = result.get("message", {})
                
                # Check if tool was called
                if "tool_calls" in msg and msg["tool_calls"]:
                    # Append the assistant's tool call request
                    messages.append(msg)
                    
                    for tc in msg["tool_calls"]:
                        func = tc.get("function", {})
                        if func.get("name") == "web_search":
                            args = func.get("arguments", {})
                            query = args.get("query", "")
                            print(f"  🔧 [Tool] Searching: {query}")
                            search_res = web_search(query)
                            
                            messages.append({
                                "role": "tool",
                                "content": search_res[:2000] # Provide snippet
                            })
                    # Loop back to model
                    continue
                else:
                    # Final response generated
                    return self._parse_json_response(msg.get("content", ""))

            except requests.RequestException as e:
                print(f"[LLM] Request exception: {e}")
                return None
        
        # Max turns exceeded
        return None

    def _parse_json_response(self, content: str) -> Optional[Dict[str, Any]]:
        try:
            content = content.strip()

            if "```" in content:
                # Naive markdown strip
                lines = content.split("\n")
                content = ""
                in_code = False
                for line in lines:
                    if line.startswith("```"):
                        in_code = not in_code
                        continue
                    if in_code:
                        content += line + "\n"
                content = content.strip()

            start = content.find("{")
            end = content.rfind("}") + 1
            if start != -1 and end > start:
                content = content[start:end]

            data = json.loads(content)
            
            # Bare minimum validation
            if "id" not in data or "name" not in data or "contextLength" not in data:
                return None
                
            return data
            
        except Exception as e:
            print(f"[LLM] Parsing error: {e}")
            return None

    def compile_model(self, model_data: dict, backend: Optional[Dict[str, str]] = None) -> Optional[CompiledModelInfo]:
        model_id = model_data.get("modelId", model_data.get("id", ""))
        name = model_data.get("name", "")
        provider = model_data.get("provider", "")
        
        prompt = f"Extract and verify exactly the correct metadata for the model '{name}' (ID: {model_id}) by provider '{provider}'. Use the web_search tool to find accurate pricing and context window size. Start now."
        
        b = backend or self.backend
        result = self._call_ollama_with_tools(prompt, b)
        if result:
            try:
                # Fallbacks for raw inputs if LLM drops them
                if not result.get("id"): result["id"] = model_id
                if not result.get("source"): result["source"] = provider
                return CompiledModelInfo(**result)
            except Exception as e:
                print(f"Schema mismatch: {e}")
                return None
        return None

def compile_model_worker(args):
    model_data, backend = args
    service = ToolCallingLLMService(backend["model"])
    result = service.compile_model(model_data, backend)
    if result:
        # Convert dataclass to dict
        return {
            "success": True,
            "data": result.__dict__
        }
    return {"success": False, "id": model_data.get("modelId", "")}

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python llm_service.py <model_json>")
        sys.exit(1)

    service = ToolCallingLLMService()
    try:
        model = json.loads(sys.argv[1])
        result = service.compile_model(model)
        if result:
            print(json.dumps({"success": True, "data": result.__dict__}))
        else:
            print(json.dumps({"success": False}))
    except Exception as e:
        print(f"Error: {e}")
