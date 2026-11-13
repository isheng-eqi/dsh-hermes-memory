# Third-party notices

The bounded memory-content checks in `lib/core.js` and their dynamic mirror in `host.js` are adapted from `tools/threat_patterns.py` in [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41), revision `0f0e96fc8e7fd35aba406e4a9fa341fb969d0b41`. The dual-bank memory design is also inspired by that project. Memory routing guidance, the background review prompt, operations normalization, matching semantics and final-bank validation in `lib/prompts.js` and `lib/core.js` are adapted from the same project's `tools/memory_tool.py`, `tools/memory_tool_store.py`, `agent/prompt_builder.py` and `agent/background_review.py` at revision `c0c4357744d1a6994d332b826aea4c77fcccaf38` (2026-11-11). This plugin is an independent DSH adaptation, with compatibility and behavior differences documented in the README. The plugin icon is original artwork distributed under this package's MIT license.

The offline contract examples in `tests/fixtures/hermes-memory-c0c43577.json` and their runner in `tests/upstream-compatibility.test.mjs` are adapted from `tools/memory_tool_store.py`, `tests/tools/test_memory_tool.py`, `tests/tools/test_memory_patch_action.py` and `tests/tools/test_memory_target_contract.py` at the same full revision `c0c4357744d1a6994d332b826aea4c77fcccaf38`. Per-case test-function mappings and explicitly marked implementation-derived probes are recorded in the fixture; source hashes and scope are documented in `docs/upstream-compatibility.md`. These examples test selected behavior in the independent DSH v2 JSON format, not Hermes on-disk format interoperability.

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
