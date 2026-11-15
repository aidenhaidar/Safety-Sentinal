import type { AlertRule, Conn, Incident, NodeState, Store, ZoneState } from '../core/types';

const copy = <T>(x: T): T => (x === undefined ? x : structuredClone(x));

/** In-memory stand-in for the DynamoDB table (local dev and tests). */
export class MemoryStore implements Store {
  conns = new Map<string, Conn>(); nodes = new Map<string, NodeState>(); zones = new Map<string, ZoneState>();
  rules?: AlertRule[]; incidents: Incident[] = [];
  async getConn(id: string) { return copy(this.conns.get(id)); }
  async putConn(c: Conn) { this.conns.set(c.connectionId, copy(c)); }
  async delConn(id: string) { this.conns.delete(id); }
  async listConns() { return copy([...this.conns.values()]); }
  async getNode(id: string) { return copy(this.nodes.get(id)); }
  async putNode(n: NodeState) { this.nodes.set(n.nodeId, copy(n)); }
  async listNodes() { return copy([...this.nodes.values()]); }
  async getZone(z: string) { return copy(this.zones.get(z)); }
  async putZone(z: ZoneState) { this.zones.set(z.zone, copy(z)); }
  async getRules() { return copy(this.rules); }
  async putRules(r: AlertRule[]) { this.rules = copy(r); }
  async putIncident(i: Incident) { this.incidents.unshift(copy(i)); }
  async listIncidents(limit: number) { return copy(this.incidents.slice(0, limit)); }
}
