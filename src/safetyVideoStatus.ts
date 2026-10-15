import type { SafetyVideoRoamState } from './safetyVideoRoam.ts';

/** Inputs that can change playback controls without a business-data update. */
export type SafetyVideoStatusInput = {
  sourceKey: string; currentSource: string; selectedMedia?: string; mode: string;
  bound: boolean; loading: boolean; currentTime: number; duration: number;
  paused: boolean; ended: boolean; rate: number; readyState: number;
  errorCode?: number; errorMessage?: string;
};

/** The scene clock also ticks while a user pans a paused scene. Such ticks must
 * not republish the whole management context or recreate scene controls. */
export class SafetyVideoStatusChanges {
  private previous?: string;

  changed(input: SafetyVideoStatusInput): boolean {
    const next = JSON.stringify(input);
    if (next === this.previous) return false;
    this.previous = next;
    return true;
  }
}

/** Frame timestamps use the normal playback cadence; state transitions must
 * still reach controls immediately, including validation of a paused video. */
export function safetyVideoRoamStatusKey(state?: SafetyVideoRoamState): string {
  if (!state) return '';
  return JSON.stringify([state.available, state.enabled, state.active, state.state,
    state.label, state.message, state.missing, state.mode, state.userWantsFollow]);
}
