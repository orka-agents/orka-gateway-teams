import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { auditInbox } from '../src/ingress/table-audit.js';
import { InboxIndex } from '../src/ingress/table-index.js';
import { code } from './support/owned-audit.js';
import { deferred, eventually, ingressBinding, syntheticToken } from './support/table-service.js';
import { inboxOwned, auditBudget, indexBudget, install, pair } from './support/table-ingress-audit.js';
import { stateFixture } from './support/table-ingress.js';

for (const stop of ['cancel', 'deadline', 'request-timeout', 'close', 'invalidate'] as const)
  for (const transport of ['token', 'request'] as const)
    test('native audit retains credits until actual ' + transport + ' drain after ' + stop, async t => {
      const { s, k, tokens } = await inboxOwned(t); await install(k, { state: stateFixture(), pairs: [pair()] });
      let begins = 0; let disposed = 0; let meta = 0; let scratch = 0; let records = 0;
      const begin = InboxIndex.prototype.begin; const reserve = InboxIndex.prototype.reserveWorking; const dispose = InboxIndex.prototype.dispose;
      const add = InboxIndex.prototype.addEvent;
      InboxIndex.prototype.begin = function () { begins++; begin.call(this); };
      InboxIndex.prototype.reserveWorking = function (...args) {
        const token = reserve.apply(this, args); const d = this.diagnostics(); meta = d.working.meta; scratch = d.working.scratch; return token;
      };
      InboxIndex.prototype.dispose = function () { dispose.call(this); disposed++; meta = this.diagnostics().working.meta; scratch = this.diagnostics().working.scratch; };
      InboxIndex.prototype.addEvent = function (...args) { records++; add.apply(this, args); };
      const gate = deferred<string>(); const token = s.dependencies.token;
      let heldSignal: AbortSignal | undefined; let release: (() => void) | undefined; let holding = false; let requests = 0;
      // First M point read + first M page complete, then hold the first data request.
      tokens.hook = async (...args) => {
        if (++requests === 3 && transport === 'token') { holding = true; heldSignal = args[1].signal; return gate.promise; }
        return token(...args);
      };
      if (transport === 'request') {
        let native = 0;
        s.controls.hook = e => { if (requests === 3) { holding = true; return; } e.reply(); };
        s.controls.request = ((...args: Parameters<typeof https.request>) => {
          const req = s.request(...args);
          if (++native === 3) { const destroy = req.destroy.bind(req); req.destroy = () => { release = () => { destroy(); }; return req; }; }
          return req;
        }) as typeof https.request;
      }
      const abort = new AbortController(); abort.signal.addEventListener('abort', e => e.stopImmediatePropagation());
      let settled = false; let closed = false; let closing: Promise<void> | undefined;
      const expected = stop === 'invalidate' ? 'unresolved' : stop === 'request-timeout' ? 'unavailable' : 'incomplete';
      try {
        const audit = auditInbox(k, ingressBinding, { ...auditBudget, maxDurationMs: stop === 'deadline' ? 200 : 30000 }, indexBudget,
          { signal: abort.signal, requestTimeoutMs: stop === 'request-timeout' ? 200 : 30000 })
          .then(() => { settled = true; return false; }, e => { settled = true; return code(expected)(e); });
        await eventually(() => holding); assert.equal(begins, 1); assert.equal(meta, 65536); assert.equal(scratch, 2240 * 1024);
        if (stop === 'cancel') abort.abort();
        if (stop === 'close') closing = k.close().then(() => { closed = true; });
        if (stop === 'invalidate') { k.invalidate(); closing = assert.rejects(k.close(), code('unresolved')).then(() => { closed = true; }); }
        await eventually(() => transport === 'token' ? heldSignal!.aborted : !!release);
        await new Promise(r => setTimeout(r, 20));
        assert.equal(settled, false); assert.equal(closed, false); assert.equal(disposed, 0); assert.equal(k.status().pending, 1);
        assert.equal(records, 0); assert.equal(meta, 65536); assert.equal(scratch, 2240 * 1024);
        delete s.controls.hook; delete s.controls.request;
        if (transport === 'token') gate.resolve(syntheticToken); else release!();
        assert.equal(await audit, true); assert.equal(disposed, 1); assert.equal(meta, 0); assert.equal(scratch, 0); assert.equal(records, 0);
        await (closing ?? k.close()); assert.equal(s.stats.requests, s.stats.requestCloses); assert.equal(s.stats.requests, s.stats.socketCloses);
      } finally {
        gate.resolve(syntheticToken); release?.(); delete s.controls.request; delete s.controls.hook; delete tokens.hook;
        InboxIndex.prototype.begin = begin; InboxIndex.prototype.reserveWorking = reserve; InboxIndex.prototype.dispose = dispose; InboxIndex.prototype.addEvent = add;
      }
    });
