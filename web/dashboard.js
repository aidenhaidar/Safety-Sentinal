const AGENTS = { gunshot: 'Gunshot agent', weapon: 'Weapon agent', altercation: 'Altercation agent', hazard: 'Hazard agent' };
const AGENT_HINT = { gunshot: 'listens for gunfire', weapon: 'watches for rifles, handguns, blades', altercation: 'fights, screaming', hazard: 'fire, smoke, alarms, glass' };
const TIER = { critical: 'Critical position ×1.0', standard: 'Standard position ×0.8', peripheral: 'Peripheral position ×0.6' };
const DRILLS = [['gunshot', 'Gunshot heard'], ['rifle', 'Rifle on camera'], ['shooter', 'Active shooter'], ['fight', 'Fight'], ['fire', 'Fire'], ['fireworks', 'Fireworks (should stay low)'], ['clear', 'Clear']];
const LEVELS = ['ELEVATED', 'HIGH', 'CRITICAL'];
const $ = (id) => document.getElementById(id);

const state = { nodes: new Map(), zones: new Map(), thumbs: new Map(), incidents: [], rules: [], selected: null, addingRule: false };
let code = new URLSearchParams(location.search).get('code') || store('sentinel-code') || '';
if (CONFIG.joinCodeRequired && !code) code = prompt('Join code') || '';
if (code) store('sentinel-code', code);

const ws = connect({
  hello: () => ({ action: 'hello', role: 'dashboard', code }),
  onStatus(on) { $('status').replaceChildren(h('span', { class: `dot ${on ? 'on' : ''}` }), on ? 'Live' : 'Reconnecting…'); },
  onMessage(m) {
    if (m.type === 'snapshot') {
      state.nodes = new Map(m.nodes.map((n) => [n.nodeId, n])); state.zones = new Map(m.zones.map((z) => [z.zone, z]));
      state.incidents = m.incidents; state.rules = m.rules; renderAll();
    } else if (m.type === 'assessment') {
      state.nodes.set(m.node.nodeId, m.node); state.zones.set(m.zone.zone, m.zone);
      if (m.thumb) state.thumbs.set(m.node.nodeId, m.thumb);
      renderZones(); renderNodes(); if (state.selected === m.node.nodeId || !state.selected) renderDetail();
    } else if (m.type === 'incident') { state.incidents.unshift(m.incident); state.incidents.length = Math.min(state.incidents.length, 25); renderIncidents(); }
    else if (m.type === 'rules') { state.rules = m.rules; renderRules(); }
    else if (m.type === 'error') { alert(m.message); if (m.code === 'bad_code') { try { localStorage.removeItem('sentinel-code'); } catch {} } }
  },
});

function bar(score, level, initial) {
  return h('div', { class: `bar ${level}` }, h('i', { style: `width:${pct(score)}` }), initial !== undefined && Math.abs(initial - score) >= 0.02 ? h('b', { style: `left:${pct(initial)}`, title: `before hearing the others: ${pct(initial)}` }) : null);
}
const levelOf = (s) => (s >= 0.75 ? 'CRITICAL' : s >= 0.5 ? 'HIGH' : s >= 0.25 ? 'ELEVATED' : 'SAFE');

function renderZones() {
  const zones = [...state.zones.values()].filter((z) => z.contributors.length).sort((a, b) => b.score - a.score);
  $('zones').replaceChildren(...(zones.length ? zones.map((z) => h('div', { class: `zone ${z.level}` },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, z.zone), h('span', { class: `badge ${z.level}` }, z.level)),
    h('div', { class: 'score mono' }, pct(z.score)),
    h('div', { class: 'dim', style: 'font-size:13px' }, z.contributors.map((c) => `${c.name} ${pct(c.contribution)}`).join(' · ')),
  )) : [h('div', { class: 'empty' }, 'No zones yet. Add a phone to create one.')]));
}

function renderNodes() {
  const nodes = [...state.nodes.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  if (!state.selected && nodes.length) state.selected = nodes[0].nodeId;
  $('nodes').replaceChildren(...(nodes.length ? nodes.map((n) => {
    const thumb = state.thumbs.get(n.nodeId);
    return h('button', { class: `node ${n.level} ${n.nodeId === state.selected ? 'sel' : ''} ${n.online ? '' : 'off'}`, onclick: () => { state.selected = n.nodeId; renderNodes(); renderDetail(); } },
      thumb ? h('img', { src: `data:image/jpeg;base64,${thumb}`, alt: `Latest frame from ${n.name}` }) : h('div', { class: 'noimg' }, n.online ? 'Waiting for camera…' : 'Offline'),
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, n.name), h('span', { class: `badge ${n.level}` }, n.drill ? `DRILL ${n.level}` : n.level)),
      h('div', { class: 'dim', style: 'font-size:12px;margin:2px 0 6px' }, `${n.zone} · ${n.tier}${n.online ? '' : ' · offline'}`),
      bar(n.score, n.level), h('div', { class: 'mono', style: 'font-size:13px;margin-top:4px' }, `Danger ${pct(n.score)}`));
  }) : [h('div', { class: 'empty' }, 'No sensor nodes connected. Use “Add a phone as a sensor”.')]));
}

function renderDetail() {
  const n = state.nodes.get(state.selected);
  if (!n) { $('detail').replaceChildren(h('div', { class: 'empty' }, 'Select a node to see how its agents reason.')); return; }
  const chips = (obj, f) => Object.entries(obj || {}).map(([k, v]) => h('span', { class: 'chip' }, `${k} ${f(v)}`));
  $('detail').replaceChildren(...[
    h('div', { class: 'row wrap' }, h('strong', { class: 'grow' }, n.name), h('span', { class: 'chip' }, TIER[n.tier]), h('span', { class: `badge ${n.level}` }, `${n.level} ${pct(n.score)}`)),
    h('div', { style: 'margin:8px 0' },
      h('div', { class: 'dim', style: 'font-size:12px' }, 'Heard (audio classifier)'), n.heard && Object.keys(n.heard).length ? chips(n.heard, pct) : h('span', { class: 'chip' }, 'nothing notable'),
      h('div', { class: 'dim', style: 'font-size:12px;margin-top:6px' }, 'Seen (Rekognition)'), n.seen && Object.keys(n.seen).length ? chips(n.seen, (v) => `${v}%`) : h('span', { class: 'chip' }, 'no labels yet')),
    ...(n.opinions.length ? n.opinions : Object.keys(AGENTS).map((agent) => ({ agent, score: 0, initial: 0, rationale: 'Waiting for data.', by: 'rules' }))).map((o) => h('div', { class: 'agent' },
      h('div', { class: 'row' }, h('strong', {}, AGENTS[o.agent]), h('span', { class: 'dim grow', style: 'font-size:12px' }, AGENT_HINT[o.agent]),
        o.subtype ? h('span', { class: 'chip' }, o.subtype) : null, h('span', { class: 'mono' }, pct(o.score))),
      h('div', { style: 'margin-top:6px' }, bar(o.score, levelOf(o.score), o.initial)),
      h('p', {}, o.rationale, o.by === 'llm' ? h('span', { class: 'chip', style: 'margin-left:6px' }, 'revised by LLM') : null))),
    n.llmStatus ? h('div', { class: 'dim', style: 'font-size:12px;margin-top:4px' }, n.llmStatus) : null,
    h('div', { class: 'dim', style: 'font-size:12px;margin-top:6px' }, 'The white tick marks each agent’s score before it heard the other agents and nearby nodes.'),
    h('div', { style: 'border-top:1px solid var(--line);margin-top:12px;padding-top:10px' },
      h('div', { class: 'dim', style: 'font-size:12px;margin-bottom:6px' }, 'Run a drill on this node (alerts are marked [DRILL])'),
      h('div', { class: 'row wrap' }, DRILLS.map(([id, label]) => h('button', { class: 'small', disabled: !n.online, onclick: () => ws.send({ action: 'simulate', nodeId: n.nodeId, scenario: id }) }, label))))].filter(Boolean));
}

function renderIncidents() {
  $('incidents').replaceChildren(...(state.incidents.length ? state.incidents.map((i) => h('div', { class: `incident ${i.level}` },
    h('div', { class: 'row wrap' }, h('span', { class: `badge ${i.level}` }, i.mode === 'DRILL' ? `DRILL · ${i.level}` : i.level), h('span', { class: 'dim mono', style: 'font-size:12px' }, new Date(i.ts).toLocaleTimeString())),
    h('div', {}, i.summary),
    i.actions.map((a) => h('div', { class: 'act' }, `${a.status === 'failed' ? '✕' : '→'} ${a.ruleName}${a.target ? ` (${a.target})` : ''}: ${a.detail}`)),
    i.actions.length ? null : h('div', { class: 'act' }, 'No alert rule matched.'))) : [h('div', { class: 'empty' }, 'No incidents. An incident opens when a zone reaches HIGH.')]));
}

function renderRules() {
  const save = (rules) => ws.send({ action: 'setRules', rules });
  const describe = (r) => `${r.action === 'sms' ? `Text ${r.target}` : 'Dial police (simulated)'} at ${r.minLevel}+ for ${r.threats.length ? r.threats.join(', ') : 'any threat'}`;
  const form = state.addingRule ? h('form', { onsubmit(e) {
      e.preventDefault(); const f = new FormData(e.target);
      const threats = Object.keys(AGENTS).filter((a) => f.get(`t-${a}`));
      save([...state.rules, { id: `r-${Date.now()}`, name: f.get('name') || 'Custom alert', enabled: true, minLevel: f.get('minLevel'), threats, action: f.get('action'), target: f.get('target') }]);
      state.addingRule = false; renderRules();
    } },
    h('label', { for: 'rn' }, 'Name'), h('input', { id: 'rn', name: 'name', placeholder: 'Text the head of security', maxlength: 80 }),
    h('label', { for: 'ra' }, 'Action'), h('select', { id: 'ra', name: 'action' }, h('option', { value: 'sms' }, 'Send a text message (Amazon SNS)'), h('option', { value: 'dispatch' }, 'Dial police (simulated, never places a call)')),
    h('label', { for: 'rt' }, 'Phone number for text messages'), h('input', { id: 'rt', name: 'target', placeholder: '+15551234567', inputmode: 'tel' }),
    h('label', { for: 'rl' }, 'When the zone reaches'), h('select', { id: 'rl', name: 'minLevel' }, LEVELS.map((l) => h('option', { value: l, selected: l === 'HIGH' }, l))),
    h('label', {}, 'Threat types (none ticked = any)'),
    h('div', { class: 'row wrap' }, Object.keys(AGENTS).map((a) => h('label', { style: 'margin:0;display:flex;gap:5px;align-items:center;color:var(--text)' }, h('input', { type: 'checkbox', name: `t-${a}`, style: 'width:auto' }), a))),
    h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Save alert'), h('button', { type: 'button', onclick: () => { state.addingRule = false; renderRules(); } }, 'Cancel')))
    : h('button', { style: 'margin-top:10px', onclick: () => { state.addingRule = true; renderRules(); } }, 'Add custom alert');
  $('rules').replaceChildren(
    h('div', { class: 'dim', style: 'font-size:13px;margin-bottom:6px' }, 'Subscribers of the SNS alerts topic are always notified at HIGH and above. Add rules for specific people or actions.'),
    ...state.rules.map((r) => h('div', { class: 'rule' },
      h('input', { type: 'checkbox', style: 'width:auto', checked: r.enabled, 'aria-label': `Enable ${r.name}`, onchange: (e) => save(state.rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x))) }),
      h('div', {}, h('div', {}, r.name), h('div', { class: 'dim', style: 'font-size:12px' }, describe(r))),
      h('button', { class: 'small', onclick: () => save(state.rules.filter((x) => x.id !== r.id)) }, 'Remove'))),
    form);
}

function renderAll() { renderZones(); renderNodes(); renderDetail(); renderIncidents(); renderRules(); }
renderAll();

$('addPhone').onclick = () => {
  const url = new URL('node.html', location.href); if (code) url.searchParams.set('code', code);
  $('qr').replaceChildren(); new QRCode($('qr'), { text: url.href, width: 220, height: 220 });
  $('nodeUrl').textContent = url.href; $('phoneDlg').showModal();
};
$('closeDlg').onclick = () => $('phoneDlg').close();
