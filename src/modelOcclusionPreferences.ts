import type { SceneDisplayGroup } from './sceneDisplayStore';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type OcclusionChoice = 'default' | 'on' | 'off';
const maximumRules = 2048;

export class ModelOcclusionPreferences {
  private snapshot?: { key: string; rules: Map<string, boolean> };

  constructor(private readonly storage?: StoragePort) {}

  private key(projectId: string, actorId?: string): string {
    return `model-occlusion:v1:${JSON.stringify([projectId, actorId ?? null])}`;
  }

  private load(key: string): Map<string, boolean> {
    const raw = (this.storage ?? globalThis.localStorage).getItem(key);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed).filter((entry): entry is [string, boolean] => entry[0].length > 0 && entry[0].length <= 500 && typeof entry[1] === 'boolean');
    return new Map(entries.slice(0, maximumRules));
  }

  read(projectId: string, actorId?: string): ReadonlyMap<string, boolean> {
    const key = this.key(projectId, actorId);
    if (this.snapshot?.key !== key) this.snapshot = { key, rules: this.load(key) };
    return this.snapshot.rules;
  }

  invalidate(key: string | null): void {
    if (key === null || this.snapshot?.key === key) this.snapshot = undefined;
  }

  update(projectId: string, actorId: string | undefined, ids: readonly string[], choice: OcclusionChoice): void {
    const key = this.key(projectId, actorId), next = this.load(key);
    for (const id of ids) {
      if (choice === 'default') next.delete(id);
      else next.set(id, choice === 'on');
    }
    if (next.size > maximumRules) throw new Error(`最多保存 ${maximumRules} 个工程模型遮挡设置。`);
    (this.storage ?? globalThis.localStorage).setItem(key, JSON.stringify(Object.fromEntries(next)));
    this.snapshot = { key, rules: next };
  }
}

export function engineeringGroupModelIds(group: SceneDisplayGroup, models: ReadonlySet<string>): string[] {
  return [...new Set(group.members.flatMap(member => {
    const id = member.startsWith('layer:') ? member.slice('layer:'.length) : '';
    return models.has(id) ? [id] : [];
  }))];
}
