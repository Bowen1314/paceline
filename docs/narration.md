# Demo narration

Voice-over for `docs/demo-hd.mp4`, spoken by a hosted neural voice (edge-tts, `en-US-AndrewNeural`, rate +5%).
`scripts/record_demo.mjs` reads this table (`NARRATION=1`), generates one clip per row, and holds each scene until its
clip has finished. Rows marked *variant* are used only when that branch happens (rule-based planner, template text,
dry run). The on-screen captions stay as they are; the narration says the same things in spoken form.

| Scene | Key | Narration |
| --- | --- | --- |
| Title card | `title` | Paceline: milestone billing where a paid invoice is a real dependency in the plan. |
| Live workspace | `workspace-live` | This is a live PayPal sandbox workspace: every invoice here is a real sandbox invoice. |
| Dry run (variant) | `workspace-dry` | This is a dry run in the simulator. |
| PayPal host | `sandbox-host` | It's sandbox only: the PayPal host is pinned to the sandbox API. |
| Brief | `brief` | Paste a brief, or pick a sample. Paceline only uses figures written in the brief. |
| Propose | `propose` | Propose a plan. The wait is sped up in this video. |
| Plan by the model | `plan-model` | Nemotron, running on Nebius, drafted this plan. |
| Plan by the rules (variant) | `plan-fallback` | The model is unavailable right now, so the built-in rule-based planner drafted this plan, and the app says so. |
| Plan checked | `plan-checked` | The plan is checked against the brief before you see it. Nothing has gone to PayPal yet. |
| Gates | `gates` | Each milestone has a gate: it starts when the previous invoice is paid, or the previous work is delivered. |
| Blocked | `blocked` | Plan approved. The second milestone is blocked until the deposit invoice is paid. |
| Approval gate | `proposal` | The agent proposes the deposit invoice and lists the exact PayPal calls. Nothing is sent until you approve. |
| Approved (live) | `approved-live` | Approved: Paceline creates and sends the invoice through PayPal's sandbox API. |
| Approved (variant) | `approved-dry` | Approved. In the simulator, the invoice is created and sent without calling PayPal. |
| Ledger row | `ledger-row` | The ledger row gets its PayPal invoice number, status Awaiting. |
| Payment (live) | `payment-live` | The client pays. For this recording, the payment is recorded through PayPal's sandbox API, and PayPal sends the same signed invoice-paid webhook a buyer payment would. |
| Payment (variant) | `payment-dry` | In this dry run, the simulator's buyer pays. |
| Webhook wait | `webhook-wait` | Now we wait for PayPal's webhook, sped up. |
| Webhook already in (variant) | `webhook-arrived` | PayPal's webhook has already arrived. |
| Webhook verified | `verified` | The webhook is verified with PayPal, the invoice is re-read, and the plan is recomputed. |
| Unlocked | `unlocked` | The deposit is paid, so the next milestone goes from Blocked to Scheduled. |
| Explanation | `explain-model` | The agent explains the new delivery date. Every figure is checked against PayPal and plan data. |
| Explanation (variant) | `explain-template` | The agent explains the new delivery date in template text built from PayPal and plan data, because the model is unavailable. |
| Gantt | `gantt` | In the Bryntum Gantt, each milestone is a work bar and an invoice bar, linked by dependencies. |
| Paid gate | `paid-gate` | The paid gate is a real dependency: dashed while the invoice is open, green once PayPal confirms. |
| Ledger question | `ledger-ask` | In the AG Grid ledger, plain-language questions become validated filters. |
| Simulator | `simulator` | Next, the simulator that public visitors get: a sample workspace with a late invoice. |
| Overdue | `overdue` | An invoice is overdue. Everything gated on it slides, and the project shows how far it is behind plan. |
| Reminder draft | `reminder` | The agent drafts a reminder for you to edit and approve. Nothing is sent without your click. |
| Reminder approved | `reminder-approved` | Approved in the simulator, so no email is sent. |
| Group by client | `group` | Row grouping: the ledger by client, with totals. |
| Outro card | `outro` | Paceline. The plan moves when PayPal says the money moved, and nothing is sent without your approval. |
