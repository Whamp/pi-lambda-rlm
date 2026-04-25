# Local Lambda-RLM fork boundary

This directory vendors the upstream `rlm` package from
`https://github.com/lambda-calculus-LLM/lambda-RLM` at commit
`3874d393483dc4299101918cf8e9af670194bd88`.

Intentional local patches for issue #5:

1. `rlm.lambda_rlm.LambdaRLM.__init__(..., client: BaseLM | None = None)` stores
   an optional injected client.
2. `LambdaRLM.completion()` selects `self.client or get_client(self.backend,
   self.backend_kwargs)`, so injected offline tests avoid provider credentials
   while omitted-client behavior still delegates to the upstream client factory.
3. `rlm.clients.__init__` tolerates missing `python-dotenv` at import time. Provider
   clients remain lazily imported by `get_client`, preserving default behavior when
   provider dependencies and credentials are installed.
4. `LambdaRLM.completion()` includes metadata documenting this patch boundary.

Do not replace the real `LocalREPL`/`LMHandler` Lambda-RLM execution path with a
simplified direct recursive executor. Tests under `tests/python/` assert that
filter, leaf, and reducer calls flow through `LocalREPL`/`LMHandler`.
