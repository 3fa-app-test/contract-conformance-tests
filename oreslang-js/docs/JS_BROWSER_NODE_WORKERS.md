# Browser/Node JavaScript workers vs Oreslang Wasm (experimental)

## Two separate targets

| Property | JS ESM target (`oreslang-source.js`) | Wasm target (`oreslang-wasm`) |
| --- | --- | --- |
| Output | JavaScript ES module; BigInt support | wasm32 LLVM/Clang artifact in a separate experimental bridge |
| Runtime | Browser ESM, Node 22 ESM, edge JS as supported | Browser WebAssembly, Node or WASI host after import validation |
| Memory | JS managed objects/GC and structured clone | Linear memory; explicit bounds/ownership ABI planned |
| Actors | This PR: trusted-host module Web Worker / Node worker-thread serial reference | Host-side owned-envelope and serial actor reference; no full guest actor lowering |
| Concurrency | One dedicated Worker per actor (heavy, no pooling yet) | Wasm MVP single-threaded runtime prototype without actor scheduler |
| Isolation | Worker execution isolation, **not** an untrusted JS sandbox | Wasm instance memory boundaries, **not** a complete sandbox without host controls |
| Parity | Shared typed IR and core/stdlib compilation not implemented | LLVM-based guest compilation narrow, runtime ABI distinct from guest binary |

## Compile and execute on Node

Use the experimental program-v2 compiler, not arbitrary guest source:

```sh
node bin/oreslang-jsc.mjs --program-v2 input.ores --out=/absolute/generated.mjs
node -e 'import("file:///absolute/generated.mjs").then(m=>console.log(m.answer()))'
npm run test:workers
```

Call a compiled, synchronous exported function on a Worker:

```js
import {spawnNodeActor} from '@oreslang/source-js/actor-host.node';
const actor=spawnNodeActor({moduleUrl:'file:///absolute/generated.mjs',exportName:'answer',mode:'call'});
try {await actor.ready;console.log(await actor.request({args:[]}));}
finally {await actor.close();}
```

## Compile and execute in the browser

Serve this repository from its root on trusted localhost HTTP(S), e.g. `python3 -m http.server 8000`. Then open `http://localhost:8000/tests/browser-worker-smoke.html`.

The fixture compiles Oreslang via `compileProgramV2`, imports the generated ESM from an object URL, invokes a transpiled function in a module Web Worker, then verifies an explicit serial trusted-JS handler. This is a **manual integration fixture, not a browser-CI receipt**. Production hosts should load reviewed immutable generated ESM, enforce CSP and avoid compiling untrusted input in browsers.

`spawnBrowserActor({moduleUrl,exportName,mode,maxPending})` accepts same-origin HTTP(S) and Blob modules and requires module Web Workers. `spawnNodeActor` imports trusted local `file:` modules through Node worker_threads. Both host adapters use the same serial message protocol.

## Host reference semantics

- One FIFO serial handler lane per Worker. `await` inside the handler does not release the lane to another message.
- Bounded outstanding messages via `maxPending`. `request()` resolves only after explicit `self.respond(value)` **and** `self.done()`; `tell()` needs `done()` without any reply entitlement.
- Ordinary JS handler return values **never** become an implicit actor reply. Missing done/reply and handler errors fail that delivery; subsequent messages may proceed.
- `mode:'call'` adapts only synchronous transpiled scalar functions using `{args:[...]}`, explicitly turning the callable return into a response; it is **not Oreslang actor lowering**.
- `close()` terminates the Worker, rejects pending requests, and prevents new admissions. Copy-only snapshotting occurs at request admission and at self.respond(); SharedArrayBuffer and shared typed views are rejected even inside Map/Set, and transfer ownership and raw pointers remain unsupported.
- A Worker is **not an adversarial JavaScript sandbox**. Only trusted code and pinned modules may be loaded. Strong isolation needs a separate OS/process security boundary.

## Limitations and release gates

NOT yet supported: Oreslang `define actor` source lowering, typed `ActorRef<T>`, `self.send/forward`, supervision, actor groups, mailbox persistence, capability enforcement, memory arenas, transfer ownership, borrow checking, actor hot reload, select/channels, WASI/WIT, full core/alloc/stdlib transpilation, cross-backend message ABI.

Next: (1) shared versioned typed IR; (2) compiler-checked actor message/reply/ownership lowering; (3) compare Wasm owned-message envelope v1 with JS structured-clone rather than conflating them; (4) run exact Node 22 + real browser module Worker CI; (5) Java/LLVM/Wasm/JS cross-backend conformance evidence.


## CPU/GPU placement parity boundary

Browser module Workers and Node `worker_threads` do not provide Oreslang with a
portable, enforceable OS logical-CPU/NUMA pinning primitive, and this backend
does not own a GPU device broker. The actor host adapters therefore reject
placement-related options (`placement`, `cpuAffinity`, `maxParallelTurns`,
`accelerator`, `gpuDeviceId`, `maxGpuInFlight`) instead of silently ignoring
them. Worker creation is an execution/isolation boundary, **not** evidence of
CPU cache affinity or GPU residency.

Relative backend parity means the observable contract must be explicit:
Java/LLVM may eventually enforce trusted-host carrier/device placement, while
JS must report unsupported hard placement until a host-specific authority can
prove it. Source lowering must never translate `GPU_REQUIRED` or hard CPU
placement into an ordinary Worker and claim success.
