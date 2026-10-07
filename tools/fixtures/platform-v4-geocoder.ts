import { Cartographic, CartographicGeocoderService, Credit, CreditDisplay, GeocoderViewModel, Ion, IonGeocoderService, Math as CesiumMath } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "../../src/safetyWorkspace.css";
import "../../src/safetySpatialEditor.css";

/** No Viewer or real project data: runs the installed widget/service and credit DOM only. */
export async function verifyGeocoderOption(expression: string) {
  const host = document.createElement("div");
  host.className = "cesium-viewer-bottom";
  document.body.append(host);
  document.body.classList.add("safety-workspace-open");
  const creditDisplay = new CreditDisplay(host);
  const scene = { isDestroyed: () => false, frameState: { creditDisplay } } as never;
  const option = (token?: string) => new Function("token", "CartographicGeocoderService", `return (${expression});`)(token, CartographicGeocoderService);
  const local = new GeocoderViewModel({ scene, geocoderServices: option(undefined), destinationFound: (_, value) => { destination = value; } });
  let destination: unknown;
  local.autoComplete = false;
  local.searchText = "114.25 30.5 125";
  await local.search();
  const cartographic = Cartographic.fromCartesian(destination as never);
  creditDisplay.beginFrame(); creditDisplay.endFrame();
  const localWarning = host.textContent!.includes("default ion access token");
  const localServices = local._geocoderServices.map((service: unknown) => service instanceof CartographicGeocoderService);
  local.searchText = "not-a-coordinate";
  await local.search();
  const unsupportedPlaceIsEmpty = local.searchText.endsWith("(not found)");
  local.destroy();
  const previous = Ion.defaultAccessToken;
  const configuredOption = option("configured-test-token");
  // A nonsecret marker checks the unchanged token branch; it is never sent to the internet.
  Ion.defaultAccessToken = "configured-test-token";
  const configured = new GeocoderViewModel({ scene, ...(configuredOption === true ? {} : { geocoderServices: configuredOption }) });
  const configuredUsesIon = configured._geocoderServices.length === 1 && configured._geocoderServices[0] instanceof IonGeocoderService;
  configured.destroy(); Ion.defaultAccessToken = previous;
  // Positive control proves the original default Ion construction really inserts the warning.
  const control = new GeocoderViewModel({ scene });
  creditDisplay.beginFrame(); creditDisplay.endFrame();
  const positiveControlWarning = host.textContent!.includes("default ion access token");
  control.destroy();
  for (const credit of [...creditDisplay._staticCredits]) creditDisplay.removeStaticCredit(credit);
  creditDisplay.addStaticCredit(new Credit("Isolated attribution layout verification", false));
  creditDisplay.beginFrame(); creditDisplay.endFrame();
  return { localWarning, localServices, configuredUsesIon, positiveControlWarning, unsupportedPlaceIsEmpty,
    coordinate: { longitude: CesiumMath.toDegrees(cartographic.longitude), latitude: CesiumMath.toDegrees(cartographic.latitude), height: cartographic.height },
    note: "Configured-token routing checked without contacting Ion; no valid service credential was available or tested." };
}
