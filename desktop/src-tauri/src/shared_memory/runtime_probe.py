"""Offline capability gate, executed by the exact distributed interpreter."""
import importlib.metadata
import json
from pathlib import Path
import sys

root = Path(sys.executable).resolve().parent
assert sys.version_info[:3] == (3, 12, 12)
assert importlib.metadata.version('basic-memory') == '0.23.2'
import basic_memory
import onnxruntime
from fastembed import TextEmbedding

for module in (basic_memory, onnxruntime):
    assert Path(module.__file__).resolve().is_relative_to(root), 'External package fallback'
model = TextEmbedding('BAAI/bge-small-zh-v1.5', cache_dir=sys.argv[1],
                      local_files_only=True, threads=2)
vector = next(model.embed(['本地中文记忆安装核验']))
assert len(vector) == 512
print(json.dumps({'basicMemory': '0.23.2', 'dimensions': len(vector), 'offline': True}))
