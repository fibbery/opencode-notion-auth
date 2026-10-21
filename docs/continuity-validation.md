# Continuity validation and limits

## Problem and behavior

One Claude Code task can issue a main request, tool-result requests and helper
requests with different instructions, tools, models or reasoning effort. Treating
each configuration change as a new conversation creates multiple Notion chats
and repeatedly uploads the task history.

The provider now saves one workflow per authenticated account and client session.
It retains separate accepted history prefixes for interleaved branches and
appends new messages/results. Configuration changes reuse the original config
step ID. Changed or compacted history is synchronized into the existing workflow.
Successful continuation does not require a new Notion chat.

## Local automated validation

On Windows with Bun 1.4.2, the publication version passed 121 tests. They cover
session/account isolation, interleaved helpers, configuration changes, rewritten
history, old state migration, cancellation, error propagation, token accounting,
distinct tool-call IDs and native browser transport. Tests use synthetic fixtures
and local servers rather than a Notion account.

The native transport test checks the runtime's installed native module; it does
not assume the host is Windows. Linux and Windows CI are configured separately.
Local Windows results do not establish that hosted Linux CI has passed.

## Previous live acceptance check

The runtime source was previously checked on Windows with magpie 0.1.1296,
Claude Code 2.1.304 and `notion/haiku-5.5` (reported upstream model `amla-jam`).
The normal Claude Code runtime was used, with its tools explicitly restricted
to Read and Bash. The client supplied its native session identity.

| Request | Result | Workflow operation | Sent prompt characters |
| --- | --- | --- | ---: |
| Main task | Model proposed Read; Claude Code read a synthetic random-value file | Create | 44,866 |
| File result | Model proposed Bash; Claude Code executed a fixture echo command | Resume | 901 |
| Command result | Model correctly summarized the file value and command output | Resume | 865 |
| Helper request | Test harness inserted a different, tool-free helper under the same client session | Resume | 1,485 |
| Main task resumed | Claude Code resumed; model recalled the random value after the helper and an effort change | Resume | 889 |

All five requests used one Notion workflow. The helper was inserted by the test
harness rather than assumed to be an automatically generated Claude Code helper.
No fresh live requests were made to prepare this publication.

## Limits

- Tools still use the text-envelope protocol. The model proposes an action;
  Claude Code applies its own permissions and executes it, then sends the result
  back to the model. Notion does not gain direct access to local files.
- The live check establishes the Read/Bash sequence above, not reliable execution
  of every model, the complete default tool catalog or arbitrary agent tasks.
- Failed, cancelled or interrupted turns invalidate saved local workflow state.
  A later request may create a new workflow. Clients without a session identity
  keep the original full-context behavior.
- Concurrency is serialized inside one provider process; local queues are not
  a distributed lock across multiple provider processes.
- Instructions for helper contexts are labels within shared model history, not
  a security boundary. Helpers and main requests in the same client session share
  a Notion conversation. Different accounts and client sessions remain separate.
- Local state contains IDs, hashes and counters; messages and tool results sent
  upstream remain in Notion. Existing duplicate chats are not merged or deleted.
- Smaller transmitted prompts do not imply equivalent token or credit savings:
  Notion can still process stored history and its own agent framework context.
- Experimental cross-context definition deduplication is excluded. No GUI
  instruction-page or custom-Agent binding is introduced.

The transport uses Chrome impersonation for inference only, a 180-second client
timeout and no silent fallback to native fetch. This overlaps the transport
approach in upstream PR #1. Its custom-tool flag change is not adopted here;
the verified runtime keeps the previous flag value and the planner envelope.
