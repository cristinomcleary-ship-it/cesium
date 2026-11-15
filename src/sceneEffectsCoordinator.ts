export type SceneEffectsRelease = () => void;

type Participant = { id: string; suspend: () => void | SceneEffectsRelease };
type HeldParticipant = { participant: Participant; release: SceneEffectsRelease };

/** Combines existing effect owners without taking ownership of their business state.
 * Participants must roll back their own partial changes if suspend() throws.
 * Releases read each owner's current state, rather than replaying scene snapshots.
 */
export class SceneEffectsCoordinator {
  private readonly participants = new Map<string, Participant>();
  private readonly leases = new Set<object>();
  private held: HeldParticipant[] = [];
  private transitioning = false;
  private disposed = false;

  get leaseCount(): number { return this.leases.size; }

  /** Registration is safe before or after AR starts. A late participant is
   * suspended before it joins an already active composite session.
   */
  register(id: string, suspend: Participant['suspend']): SceneEffectsRelease {
    this.assertAvailable();
    if (!id.trim() || this.participants.has(id)) throw new Error(`场景效果所有者重复或无效：${id}`);
    const participant = { id, suspend };
    if (this.leases.size) {
      this.transitioning = true;
      try {
        const release = suspend();
        if (release) this.held.push({ participant, release });
      } finally { this.transitioning = false; }
    }
    this.participants.set(id, participant);
    let removed = false;
    return () => {
      if (removed) return;
      // An old registration can never unregister a later owner with the same ID.
      if (this.participants.get(id) !== participant) { removed = true; return; }
      if (this.transitioning) throw new Error('场景效果正在切换，不能移除所有者');
      removed = true; this.participants.delete(id);
      const index = this.held.findIndex(value => value.participant === participant);
      if (index < 0) return;
      const [held] = this.held.splice(index, 1);
      this.transitioning = true;
      try { held.release(); } finally { this.transitioning = false; }
    };
  }

  acquire(): SceneEffectsRelease {
    this.assertAvailable();
    if (!this.leases.size) {
      this.transitioning = true;
      try {
        for (const participant of this.participants.values()) {
          const release = participant.suspend();
          if (release) this.held.push({ participant, release });
        }
      } catch (error) {
        const rollbackErrors = this.releaseHeld();
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '场景效果暂停失败，部分回滚也发生异常', { cause: error });
        throw error;
      } finally { this.transitioning = false; }
    }
    const lease = {};
    this.leases.add(lease);
    return () => {
      if (!this.leases.has(lease)) return;
      if (this.transitioning) throw new Error('场景效果正在切换，不能重入释放');
      this.leases.delete(lease);
      if (this.leases.size) return;
      this.transitioning = true;
      try {
        const errors = this.releaseHeld();
        if (errors.length) throw new AggregateError(errors, '部分场景效果恢复失败');
      } finally { this.transitioning = false; }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.transitioning) throw new Error('场景效果正在切换，不能释放协调器');
    this.disposed = true; this.leases.clear(); this.participants.clear(); this.transitioning = true;
    try {
      const errors = this.releaseHeld();
      if (errors.length) throw new AggregateError(errors, '部分场景效果清理失败');
    } finally { this.transitioning = false; }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('场景效果协调器已释放');
    if (this.transitioning) throw new Error('场景效果正在切换，不能重入');
  }

  private releaseHeld(): unknown[] {
    const errors: unknown[] = [];
    for (const { release } of this.held.splice(0).reverse()) {
      try { release(); } catch (error) { errors.push(error); }
    }
    return errors;
  }
}
