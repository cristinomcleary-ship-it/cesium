import type { RailSafetyConstructionClass, RailSafetyMachine, RailSafetyPolygon } from "./railSafetyTypes";
import { RAIL_SAFETY_CONSTRUCTION_LABELS } from "./railSafetyTypes";

export type MachineRangeTarget = "workRange" | "fallRange" | "activityPolygon" | "zone";
export const MACHINE_RANGE_LABELS: Record<MachineRangeTarget, string> = {
  workRange: "机械自身工作范围", fallRange: "机械倾覆范围", activityPolygon: "机械活动范围", zone: "施工分类区域",
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function rangeButton(action: string, text: string, target: MachineRangeTarget, zoneId?: string) {
  const button = element("button", "", text); button.type = "button"; button.dataset.action = action; button.dataset.range = target;
  if (zoneId) button.dataset.zoneId = zoneId; return button;
}
export function machineRangePolygon(machine: RailSafetyMachine, target: MachineRangeTarget, zoneId?: string): RailSafetyPolygon | undefined {
  return target === "zone" ? machine.constructionZones?.find(zone => zone.id === zoneId)?.polygon
    : target === "activityPolygon" ? machine.activityPolygon : machine[target]?.polygon;
}
export function renderMachineRangeVertices(polygon: RailSafetyPolygon | undefined, target: MachineRangeTarget, zoneId?: string) {
  const vertices = element("div", "rs-vertices"); vertices.dataset.rangeVertices = target;
  if (zoneId) vertices.dataset.zoneId = zoneId;
  (polygon ?? []).forEach((point, index) => {
    const row = element("div", "rs-vertex"); row.dataset.vertex = String(index);
    row.append(element("span", "rs-vertex-number", String(index + 1)));
    for (const [key, label] of [["longitude", "经度"], ["latitude", "纬度"], ["height", "椭球高"]] as const) {
      const input = element("input"); input.type = "number"; input.step = "any"; input.dataset.machineCoordinate = key;
      input.dataset.range = target; input.dataset.vertexIndex = String(index); if (zoneId) input.dataset.zoneId = zoneId;
      input.value = Number.isFinite(point[key]) ? String(point[key]) : ""; input.placeholder = label;
      input.setAttribute("aria-label", MACHINE_RANGE_LABELS[target] + "顶点 " + (index + 1) + " " + label); row.append(input);
    }
    const remove = rangeButton("remove-machine-vertex", "×", target, zoneId); remove.dataset.index = String(index);
    remove.setAttribute("aria-label", "删除" + MACHINE_RANGE_LABELS[target] + "顶点 " + (index + 1)); row.append(remove); vertices.append(row);
  });
  if (polygon && !polygon.length) vertices.append(element("p", "rs-warning", "自定义区域至少需要 3 个有效角点；填写后保存配置。"));
  return vertices;
}
function rangeSection(machine: RailSafetyMachine, target: MachineRangeTarget, zoneId?: string) {
  const polygon = machineRangePolygon(machine, target, zoneId), attached = target === "workRange" || target === "fallRange";
  const section = element("section", "rs-machine-range"); section.dataset.machineRange = target; if (zoneId) section.dataset.zoneId = zoneId;
  const heading = element("div", "rs-range-heading"); heading.append(element("h4", "", MACHINE_RANGE_LABELS[target]));
  heading.append(element("span", "rs-badge", attached ? polygon ? "自定义 · 跟随机械" : "模型自动 · 实时更新" : "固定在现场"));
  section.append(heading);
  if (target === "zone") {
    const zone = machine.constructionZones!.find(item => item.id === zoneId)!;
    const nameLabel = element("label", "rs-label"); nameLabel.append(element("span", "", "区域名称"));
    const name = element("input"); name.dataset.zoneName = zone.id; name.value = zone.name; name.maxLength = 120; nameLabel.append(name);
    const classLabel = element("label", "rs-label"); classLabel.append(element("span", "", "区域施工分类"));
    const classification = element("select"); classification.dataset.zoneClass = zone.id;
    for (const id of ["A", "window", "B", "C"] as RailSafetyConstructionClass[]) classification.add(new Option(RAIL_SAFETY_CONSTRUCTION_LABELS[id], id));
    classification.value = zone.classification; classLabel.append(classification);
    const grid = element("div", "rs-range-zone-fields"); grid.append(nameLabel, classLabel); section.append(grid);
  }
  const note = target === "workRange"
    ? "默认按当前模型姿态计算；吊机采用吊臂可旋转覆盖的半径范围。自定义区域随机械站位和整机朝向移动，边界形状保持绘制值。"
    : target === "fallRange" ? "默认按当前模型姿态计算全方向倾覆范围。自定义区域随机械站位和整机朝向移动，边界形状保持绘制值。"
    : target === "activityPolygon" ? "以机械站位判断越界，触及边界仍在活动范围内；超出后在机械上方报警。活动范围固定在现场。"
    : "机械工作范围触及本区域时，按申报分类检查是否越级并报警。区域固定在现场。";
  section.append(element("p", "rs-help", note));
  const actions = element("div", "rs-actions");
  actions.append(rangeButton("draw-machine-range", polygon?.length ? "在模型上重绘" : "在模型上绘制", target, zoneId), rangeButton("add-machine-vertex", "输入角点", target, zoneId));
  if (polygon || target === "zone") actions.append(rangeButton("reset-machine-range", attached ? "恢复模型自动范围" : target === "zone" ? "移除分类区域" : "移除活动范围", target, zoneId));
  section.append(actions);
  if (polygon) {
    section.append(element("p", "rs-help", "沿边界顺序输入 WGS84 经度、纬度（°）及椭球高（m），无需重复起点。"));
    if (attached && machine[target]) {
      const anchor = machine[target].anchor;
      section.append(element("p", "rs-range-anchor", "角点基准站位 " + anchor.longitude.toFixed(6) + ", " + anchor.latitude.toFixed(6) + " · 朝向 " + anchor.heading.toFixed(1) + "°；实时移动时按此基准随动，重绘可采用当前站位。"));
    }
  }
  section.append(renderMachineRangeVertices(polygon, target, zoneId)); return section;
}
export function renderRailSafetyMachineRanges(machine: RailSafetyMachine) {
  const host = element("section", "rs-machine-ranges"); host.dataset.role = "machine-ranges";
  host.append(element("h3", "", "施工范围与越界报警"));
  host.append(element("p", "rs-help", "各范围均可在倾斜摄影模型表面点选，或输入角点坐标。显示开关只控制可见性，实时判定和报警持续更新。"));
  for (const target of ["workRange", "fallRange", "activityPolygon"] as const) host.append(rangeSection(machine, target));
  const zones = element("section", "rs-construction-zones"); zones.append(element("h4", "", "现场施工分类区域"));
  zones.append(element("p", "rs-help", "工作范围触及关联安全限界为 A 类；倾覆范围触及线路限界为天窗点施工，触及设备限界为 B 类；均未触及为 C 类。各类独立判定，层级为 A 类、天窗点、B 类、C 类。B、C 类触及 A 类或天窗点均报警，C 类触及 B 类也报警；A 类触及天窗点不报警，申报“B类施工＋天窗点施工”触及天窗点不报警、触及 A 类仍报警。可补充以下固定分类区域。"));
  for (const zone of machine.constructionZones ?? []) zones.append(rangeSection(machine, "zone", zone.id));
  const add = element("button", "", "新增施工分类区域"); add.type = "button"; add.dataset.action = "add-construction-zone"; zones.append(add);
  host.append(zones); return host;
}

