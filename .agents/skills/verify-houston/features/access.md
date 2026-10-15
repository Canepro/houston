# Access

Pending. Discover the actual candidate command paths for access and read their
help, handlers, policy owner, and CLI tests before choosing argv. No access
command is assumed to exist on the baseline.

Extend with synthetic identity/policy files in the isolated home once their
formats are known. Drive one permitted read and one denied identity through the
real CLI. Require the documented structured result and exit code, and compare
policy and workspace files before and after. Retain sanitized receipts showing
that the denied request did not perform its protected action.

Prerequisites are candidate-owned policy semantics and a fixture that reaches
the authorization gate without contacting a real identity provider or changing
accounts. Login, credential creation, real grants/revocations, and live target
access are outside the offline run. Mark them pending until their owner provides
a scoped execution route. Discovery and a missing-workspace error do not prove
authorization.
