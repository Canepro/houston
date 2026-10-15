# Workspace inventory

Pending. At the candidate head, inspect capability paths for `inventory` and its
subcommands, their help, and matching CLI tests. Existing `list` is a different
contract and does not prove a new inventory port. Record absent commands as
pending, not failed execution or a pass.

Before extending the helper, identify the port's source-of-truth files and safe
read-only mode. Add synthetic records for an owned workspace, an unknown owner,
and a missing or unreadable source in this run's isolated home. Use only actual
advertised argv. Require structured output to preserve each identity and report
unknown state as unknown, with the expected nonzero refusal where specified.
Capture stdout, stderr, exit codes, and before/after fixture bytes.

Prerequisites for live discovery are an explicitly approved host or context and
read-only access. The offline baseline neither enumerates actual engines nor
proves cross-host inventory completeness. The parent owns the candidate-specific
recipe and real-interface sweep after this port is available.
