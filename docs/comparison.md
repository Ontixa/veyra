# How Veyra fits with MCP, A2A, and agent frameworks

Veyra solves a different layer. It complements tool discovery, agent communication, and workflow
orchestration by enforcing side effects after a proposal reaches a machine.

| Layer                   | Primary question                                                        | Typical responsibility                                                                | Veyra relationship                                                                                  |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MCP and tool APIs       | What tools exist and how do I call them?                                | discovery, schemas, request/response transport                                        | Put a Veyra adapter behind or in front of a side-effecting tool call                                |
| A2A and agent messaging | How do agents exchange tasks and results?                               | identity hints, messages, task lifecycle, delegation                                  | Carry intents and receipts between agents; Veyra still enforces local authority                     |
| Agent frameworks        | How does the application reason and orchestrate?                        | model loop, memory, planning, routing, UX                                             | Keep the framework; send proposed effects to Veyra instead of invoking tools directly               |
| Sandboxes               | How is arbitrary code isolated?                                         | OS/container/VM restrictions                                                          | Useful defense in depth, especially for process adapters; Veyra is not a code sandbox               |
| Workflow engines        | How are known jobs scheduled and retried?                               | durable steps, queues, business workflows                                             | Veyra adds exact capability, approval, preview, verification, and recovery semantics at effect time |
| Veyra                   | May this exact side effect happen, did it happen, and can it be undone? | typed effects, authority, content approval, constrained execution, evidence, recovery | Execution substrate used by any of the above                                                        |

MCP authentication alone does not express that one agent may patch exactly `docs/guide.md` once for
one transaction, nor does a successful tool response prove a postcondition or enable safe rollback.
Veyra's capability and transaction records can add those semantics without replacing MCP transport.

A2A participants may describe principals and causal tasks, but remote messages remain untrusted
proposals at the Veyra boundary. An A2A signature is not automatically a local capability.

Framework guardrails and prompts are valuable for proposal quality. They are not the trusted policy
engine: prompt text cannot consume a nonce, constrain a directory handle, reserve an idempotency key,
or authenticate a receipt. Veyra intentionally stays model-independent so frameworks can change
without changing the execution trust boundary.

Runnable demonstrations live in the TypeScript SDK
[examples](../packages/sdk-typescript/examples/README.md): a minimal MCP-shaped stdio tool surface
whose side-effecting `tools/call` requests are intercepted as intents gated by capability and exact
approval (with no approval tool exposed to the agent), and an A2A-shaped task result carrying a
receipt claim that the consumer reconciles against the authoritative journal rather than trusting the
message.
