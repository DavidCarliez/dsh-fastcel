import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { isFirstParty } from './ranking.js';
import { ageText, firstTokenText, leaderText, noteText, speedText, uptimeText } from './report.js';
import styles from './client.css';

export const inject = ['slots', 'connection', 'modelDirectories'];

/** Stats are cached for 15 minutes on the host, so the pick barely moves between polls. */
const PICK_POLL_MS = 60_000;
/** While open, the panel follows replies as they finish, to show which provider served the last one. */
const PANEL_POLL_MS = 5_000;

/** Shared between the slots: which session's panel is open. */
function createBridge() {
  let snapshot = { panel: null };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    open(sessionId) { snapshot = { panel: sessionId }; listeners.forEach(listener => listener()); },
    close() { snapshot = { panel: null }; listeners.forEach(listener => listener()); },
  };
}

/** @param {{ provider: string | null, model: string | null, sessionId: string | null, refresh?: boolean }} payload */
async function requestReport(payload, signal) {
  let response;
  try {
    // Relative, so a deployment prefix in front of the harness is kept.
    response = await fetch('api/dsh-fastcel/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('fastcel could not reach the host.');
  }
  const body = await response.json().catch(() => null);
  if (body?.ok === true) return body.value;
  throw new Error(typeof body?.error?.message === 'string' ? body.error.message : 'fastcel could not load the ranking.');
}

function useStore(store) {
  return useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
}

/** The provider/model a session will use next, or null while it is unknown or unroutable. */
function useSelection(directory, loadModels) {
  const state = useStore(directory);
  const load = useRef(loadModels);
  load.current = loadModels;
  // Once per directory: the catalog load is shared per connection generation.
  useEffect(() => { load.current().catch(() => {}); }, [directory]);
  const current = state.routable === false ? null : state.current;
  return current ? { provider: current.provider, model: current.model } : null;
}

/** The host connection generation; null while disconnected. A new generation invalidates every result. */
function useGeneration(connection) {
  return useStore(connection.generation)?.id ?? null;
}

/**
 * The ranking for one session's selection, refreshed every `pollMs` and on every change of model or
 * connection. Failures and results older than three polls read as no ranking, so nothing out of date is shown.
 */
function useReport(sessionId, selection, generationId, { refreshToken = 0, pollMs = PICK_POLL_MS } = {}) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const provider = selection?.provider ?? null;
  const model = selection?.model ?? null;
  const refreshed = useRef(refreshToken);
  useEffect(() => {
    setRecord(null);
    setError(null);
  }, [sessionId, provider, model, generationId]);
  useEffect(() => {
    if (generationId === null || provider === null || model === null) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      const refresh = refreshed.current !== refreshToken;
      refreshed.current = refreshToken;
      try {
        const value = await requestReport({ provider, model, sessionId, refresh }, controller.signal);
        if (controller.signal.aborted) return;
        setRecord({ value, receivedAt: Date.now() });
        setError(null);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setRecord(null);
        setError(failure?.message ?? 'fastcel could not load the ranking.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, pollMs);
      }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, provider, model, generationId, refreshToken, pollMs]);
  useEffect(() => {
    if (!record) return undefined;
    const timer = setTimeout(() => setRecord(current => current === record ? null : current), 3 * pollMs);
    return () => clearTimeout(timer);
  }, [record, pollMs]);
  return { value: record?.value ?? null, error, loading: !record && !error && selection !== null && generationId !== null };
}

function Bolt() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>;
}

/** The pick under the composer: the top of the ranking for the session's model. Opens the panel. */
function Pick({ bridge, connection, sessionId, directory, loadModels }) {
  const selection = useSelection(directory, loadModels);
  const generationId = useGeneration(connection);
  const { value } = useReport(sessionId, selection, generationId);
  const text = value?.eligible && value.ranking ? leaderText(value.modelId, value.ranking) : undefined;
  if (!text) return null;
  const served = value.served ? ` Last reply served by ${value.served.provider}.` : '';
  return <button type="button" className="dfc-pick" onClick={() => bridge.open(sessionId)} aria-haspopup="dialog" title={`fastcel: fastest provider for ${value.modelId}.${served} Click for the full ranking.`}>
    <Bolt /><span className="dfc-pick-text">{text}</span>
  </button>;
}

function SpeedBar({ tps, max }) {
  if (tps === undefined || max <= 0) return null;
  return <span className="dfc-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, (tps / max) * 100)}%` }} /></span>;
}

function RankingTable({ value }) {
  const max = Math.max(0, ...value.ranking.map(entry => entry.tps ?? 0));
  return <table className="dfc-table">
    <thead><tr><th className="dfc-num">#</th><th>Provider</th><th className="dfc-num">Speed</th><th className="dfc-bar-cell"><span className="dfc-visually-hidden">Relative speed</span></th><th className="dfc-num dfc-optional">First token</th><th className="dfc-num dfc-optional">Uptime</th><th className="dfc-note dfc-optional"><span className="dfc-visually-hidden">Note</span></th></tr></thead>
    <tbody>{value.ranking.map((entry, index) => {
      const state = entry.demotion ? 'demoted' : index === 0 ? 'leader' : 'normal';
      const note = noteText(entry, value.modelId);
      return <tr key={entry.provider} className={`dfc-row-${state}`}>
        <td className="dfc-num dfc-rank">{index + 1}</td>
        <td className="dfc-provider">
          {entry.provider}{value.served?.provider === entry.provider && <span className="dfc-tag">last reply</span>}
          {/* On a narrow screen the note column gives way and the note moves under the provider. */}
          {note && <span className={`dfc-note-inline ${entry.demotion ? 'dfc-warning' : 'dfc-muted'}`}>{note}</span>}
        </td>
        <td className="dfc-num dfc-speed">{speedText(entry.tps)}</td>
        <td className="dfc-bar-cell"><SpeedBar tps={entry.tps} max={max} /></td>
        <td className="dfc-num dfc-muted dfc-optional">{firstTokenText(entry.ttftMs)}</td>
        <td className="dfc-num dfc-muted dfc-optional">{uptimeText(entry.uptime15m)}</td>
        <td className={`dfc-note dfc-optional ${entry.demotion ? 'dfc-warning' : 'dfc-muted'}`}>{note}</td>
      </tr>;
    })}</tbody>
  </table>;
}

/** `/fastcel` and a click on the pick: the session model's providers, fastest first. */
function Panel({ connection, sessionId, directory, loadModels }) {
  const selection = useSelection(directory, loadModels);
  const generationId = useGeneration(connection);
  const [refreshToken, setRefreshToken] = useState(0);
  const { value, error, loading } = useReport(sessionId, selection, generationId, { refreshToken, pollMs: PANEL_POLL_MS });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [value]);
  let body;
  if (generationId === null) body = <p className="dfc-empty">Not connected to the harness.</p>;
  else if (!selection) body = <p className="dfc-empty">No model is selected for this session.</p>;
  else if (error) body = <p className="dfc-empty dfc-error" role="alert">{error}</p>;
  else if (loading || !value) body = <p className="dfc-empty">Loading the ranking…</p>;
  else if (!value.eligible) body = <p className="dfc-empty">{selection.model} does not go through Vercel AI Gateway, so there is no provider to choose. Pick a gateway model to rank its providers.</p>;
  else if (value.error) body = <p className="dfc-empty dfc-error" role="alert">{value.error}</p>;
  else {
    const firstParty = value.ranking.some(entry => isFirstParty(entry.provider, value.modelId));
    body = <>
      <p className="dfc-caption">Fastest first · median over the last hour · updated {ageText(value.fetchedAt, now)}</p>
      <div className="dfc-table-scroll" tabIndex={0}><RankingTable value={value} /></div>
      {(value.notes.length > 0 || firstParty) && <ul className="dfc-notes">
        {value.notes.map(note => <li key={note}>{note}</li>)}
        {firstParty && <li>The first-party provider is the model maker's own API.</li>}
      </ul>}
    </>;
  }
  return <div className="dfc-panel">
    {body}
    <div className="dfc-footer">
      <span className="dfc-muted">Each conversation starts on the top provider; the gateway keeps it there while its cache is warm.</span>
      <button type="button" className="dfc-button" disabled={!value?.eligible || generationId === null} onClick={() => setRefreshToken(token => token + 1)}>Refresh</button>
    </div>
  </div>;
}

function PanelHost({ bridge, connection, directoryFor }) {
  const { panel } = useStore(bridge);
  const directory = useMemo(() => panel ? directoryFor(panel) : null, [panel, directoryFor]);
  return <Modal open={panel !== null} onClose={() => bridge.close()} title="fastcel" description="Vercel AI Gateway providers ranked by live throughput" closeLabel="Close fastcel" className="dfc-modal" contentClassName="dfc-modal-content">
    {directory && <Panel key={panel} connection={connection} sessionId={panel} directory={directory.store} loadModels={directory.load} />}
  </Modal>;
}

export function apply(ctx) {
  const bridge = createBridge();
  const directoryFor = sessionId => {
    const directory = ctx.modelDirectories.directoryFor(sessionId);
    return { store: directory.store, load: () => directory.load() };
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-fastcel';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  // `shell.overlay` is the additive frame-wide seat; `shell.bottom` is single and other plugins, such as
  // ds-cover, already occupy it.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-fastcel-panel',
    inject: () => ({ bridge, connection: ctx.connection, directoryFor }),
  }, PanelHost));
  // A session shows the pick below its composer; the New Session surface, which has no composer dock,
  // shows it in the options row above the composer.
  for (const name of ['conversation.composer.dock', 'conversation.hero.options']) {
    ctx.slots.inject(name, () => ctx.slots.register({
      name,
      id: `dsh-fastcel-pick-${name}`,
      order: 3,
      inject: sessionId => {
        const directory = directoryFor(sessionId);
        return { bridge, connection: ctx.connection, sessionId, directory: directory.store, loadModels: directory.load };
      },
    }, Pick));
  }
  // A bare `/fastcel` opens the panel here; with an argument it still runs on the host and prints the table.
  ctx.inject(['commandUi'], child => {
    child.effect(() => child.commandUi.decorate({
      name: 'fastcel',
      available: () => true,
      ui: { kind: 'action', run: session => bridge.open(session.sessionId) },
    }));
  });
}
