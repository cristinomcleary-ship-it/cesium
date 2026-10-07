import tokens from "./safetyDesignTokens.json";

/** One versioned source for the UI and the real Cesium scene. */
export const safetyVisualTokens = tokens;
export function applySafetyVisualTokens(host: HTMLElement): void {
  for (const [name, value] of Object.entries(tokens.colors)) host.style.setProperty(`--safety-${name}`, value);
  for (const [name, value] of Object.entries(tokens.typographyPx)) host.style.setProperty(`--safety-${name}`, `${value}px`);
  host.style.setProperty("--safety-panel-gap", `${tokens.layout.panelGap}px`);
  host.style.setProperty("--safety-button-duration", `${tokens.motion.buttonTransitionMilliseconds}ms`);
  host.style.setProperty("--safety-theme-duration", `${tokens.motion.themeTransitionSeconds}s`);
}
