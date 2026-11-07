const lengthUnits = '<option value="m">米（m）</option><option value="cm">厘米（cm）</option><option value="mm">毫米（mm）</option>';
const cadAccept = ".dwg,.dxf,.cadimport";

export const temporaryWorksFormHtml = `
<div class="tw-workbench" role="region" aria-label="临建规划">
  <div class="tw-heading">
    <div><span class="tw-kicker">施工场布</span><h2>临建规划</h2></div>
    <button id="tw-close" type="button" aria-label="关闭临建规划" title="关闭临建规划">×</button>
  </div>

  <div class="tw-scroll">
    <label class="tw-check tw-upgrade-switch"><input id="tw-upgrade-enabled" type="checkbox" checked/>启用临建模型、设计便道与场地硬化</label>
    <p class="tw-hint">关闭后暂停新增功能的显示与摄影遮挡，原有场景及历史方案继续保留。</p>
    <details open>
      <summary><span class="tw-step">01</span>临建资源库与场地选择</summary>
      <div class="tw-body">
        <div class="tw-grid">
          <label>临建类型<select id="tw-kind">
            <option value="road">施工便道 · 自定标高与纵坡</option><option value="hardening">场地硬化</option><option value="camp" selected>项目驻地 / 宣传设施</option><option value="steel">钢筋加工场</option>
          </select></label>
          <label>方案名称<input id="tw-name" type="text" maxlength="80" placeholder="如 1 号便道"/></label>
        </div>
        <div data-tw-group="site" class="tw-subgroup" hidden>
          <label>摄影场景布置方式<select id="tw-facility-mode" data-facility-scene-version="20261102g"><option value="glb" selected>真实 GLB 资源布置</option><option value="standard" hidden>历史标准设施</option><option value="cad" hidden>历史 CAD 建筑轮廓</option><option value="pad" hidden>历史硬化场坪</option></select></label>
          <label>三维资源<select id="tw-glb-resource"><option value="camp">项目部 · 中铁二十四局</option><option value="steel">钢筋棚 · 中铁二十四局</option><option value="wall">独立宣传墙</option></select></label>
          <p id="tw-glb-asset-info" class="tw-hint" role="status">正在读取模型核验信息…</p>
          <p id="tw-facility-hint" class="tw-hint"></p>
          <button type="button" id="tw-place-facility" class="tw-primary">在摄影场景中生成模型</button>
        </div>
        <div class="tw-actions tw-reference-actions" hidden><button type="button" id="tw-preview-steel">查看钢筋加工场参考样式</button><button type="button" id="tw-preview-camp">查看项目驻地参考样式</button></div>
        <label>倾斜摄影模型<select id="tw-model"><option value="">请选择已加载的摄影模型</option></select></label>
        <div id="tw-cad-controls">
        <label><span id="tw-plan-file-label">道路中心线 CAD</span><input id="tw-cad" type="file" accept="${cadAccept}"/></label>
        <div class="tw-actions tw-upload-actions"><button id="tw-replace-cad" type="button" disabled>更换图纸</button><button id="tw-remove-cad" type="button" disabled>移除图纸</button></div>
        <div class="tw-grid">
          <label>图层<select id="tw-layer"><option value="">导入后选择</option></select></label>
          <label>规划图元<select id="tw-feature"><option value="">导入后选择</option></select></label>
        </div>
        <p class="tw-hint">便道请选择未闭合的道路中心线。驻地与钢筋棚可选取闭合场界核对布置；也可直接填写底面基准位置。</p>
        <div id="tw-cad-preview" class="tw-preview" aria-label="平面图预览"></div>
        <div id="tw-cad-info" class="tw-hint"></div>
        </div>
        <div data-tw-group="road" class="tw-route-info">
          <strong id="tw-road-length" data-road-bend-version="20261102" data-road-sampling-version="20261102b" data-placement-version="20261102c" data-road-coverage-version="20261102f" data-facility-scene-version="20261102g">中心线长度待计算</strong>
          <div id="tw-road-start"></div><div id="tw-road-end"></div>
          <button type="button" id="tw-reverse" disabled>交换起终点</button>
          <small class="tw-hint">平面里程沿中心线累计。有弧长数据的圆弧按弧长，离散曲线按折线计。</small>
        </div>
        <div data-tw-group="building" class="tw-subgroup" hidden>
          <p class="tw-subtitle">自选 CAD 建筑轮廓</p>
          <div class="tw-grid">
            <label>CAD 闭合轮廓（多选）<select id="tw-building" multiple size="3"><option value="">选择建筑轮廓</option></select></label>
            <label data-tw-group="building-height" hidden>统一建筑高度（m）<input id="tw-building-height" type="number" min="0" step="any" placeholder="硬化面至顶部"/></label>
          </div>
          <p class="tw-hint">如已有建筑平面，选择轮廓后自动切换至按 CAD 布置。按住 Ctrl 或 ⌘ 可多选，再填写建筑高度。</p>
        </div>
        <div data-tw-group="camp-yard" class="tw-subgroup" hidden>
          <label class="tw-check"><input id="tw-camp-yard" type="checkbox" checked/>驻地院内布置国旗台和停车区</label>
          <p class="tw-hint">旗台、车位和通车区随建筑布置。场景预览列出实际生成的车位数。</p>
        </div>
      </div>
    </details>
    <div id="tw-hardening-editor" hidden></div>
    <details id="tw-coordinates-section" open>
      <summary><span class="tw-step">02</span>平面坐标与定位</summary>
      <div class="tw-body">
        <label>CAD 坐标系<select id="tw-coord">
          <option value="gaussKruger" selected>国家 2000（CGCS2000）· 高斯平面坐标</option>
          <option value="local">工程独立坐标 · 控制点配准</option>
          <option value="geographic">WGS84 · 经纬度</option>
        </select></label>
        <div class="tw-grid">
          <label>CAD 的 X、Y 顺序<select id="tw-axis">
            <option value="eastNorth">东、北（经、纬）</option><option value="northEast">北、东（纬、经）</option>
          </select></label>
          <label data-tw-group="linear">图纸长度单位<select id="tw-unit">${lengthUnits}</select></label>
        </div>
        <div data-tw-group="local" class="tw-subgroup">
          <p class="tw-hint">控制点 A 决定平移。可输入已知旋转角，或用控制点 B 校准方向。请选图纸与所选摄影模型上均可辨认的同一地物。</p>
          <div class="tw-grid">
            <label>控制点 A · CAD X<input id="tw-anchor-x" type="number" step="any"/></label>
            <label>控制点 A · CAD Y<input id="tw-anchor-y" type="number" step="any"/></label>
            <label>A · 经度（°）<input id="tw-anchor-lon" type="number" min="-180" max="180" step="any"/></label>
            <label>A · 纬度（°）<input id="tw-anchor-lat" type="number" min="-90" max="90" step="any"/></label>
            <label class="tw-wide">坐标旋转角（°，逆时针为正）<input id="tw-rotation" type="number" step="any" value="0"/></label>
          </div>
          <div class="tw-actions"><button type="button" id="tw-cad-a">从图纸选 A 点</button><button type="button" id="tw-pick-a">从摄影模型拾取 A 点</button></div>
          <details class="tw-controls"><summary>用第二个控制点校准方向</summary>
            <div class="tw-grid">
              <label>控制点 B · CAD X<input id="tw-b-x" type="number" step="any"/></label>
              <label>控制点 B · CAD Y<input id="tw-b-y" type="number" step="any"/></label>
              <label>B · 经度（°）<input id="tw-b-lon" type="number" step="any" min="-180" max="180"/></label>
              <label>B · 纬度（°）<input id="tw-b-lat" type="number" step="any" min="-90" max="90"/></label>
            </div>
            <div class="tw-actions"><button type="button" id="tw-cad-b">从图纸选 B 点</button><button type="button" id="tw-pick-b">从摄影模型拾取 B 点</button><button type="button" id="tw-control-fit">应用两点校准</button></div>
            <small id="tw-control-status" class="tw-hint" role="status">输入或拾取两个同名控制点后，可核对基线长度和 B 点偏差。</small>
          </details>
        </div>
        <div data-tw-group="projection" class="tw-subgroup" hidden>
          <div class="tw-grid">
            <label class="tw-wide">投影参数来源<select id="tw-projection-source"><option value="meridian">已知中央子午线</option><option value="zone">已知分带方式和带号</option></select></label>
            <label data-tw-group="meridian">中央子午线（°）<input id="tw-meridian" type="text" placeholder="按测量资料填写，如 120°47′"/></label>
            <label data-tw-group="bandwidth">分带方式<select id="tw-band-width"><option value="3">3° 分带</option><option value="6">6° 分带</option></select></label>
            <label class="tw-check"><input id="tw-prefix" type="checkbox"/>东坐标含带号</label>
            <label data-tw-group="zone" hidden>带号<input id="tw-zone" type="number" min="1" max="60" step="1" placeholder="如 40"/></label>
          </div>
          <details class="tw-controls"><summary>用同名点核对摄影模型的平面偏差</summary>
            <p class="tw-hint">填写一个已知 CAD 点，并在选定的摄影模型上拾取同一地物。先查看偏差，再决定是否将这份临建方案平移到模型上。</p>
            <div class="tw-grid">
              <label>复核点 CAD X<input id="tw-gk-x" type="number" step="any"/></label><label>复核点 CAD Y<input id="tw-gk-y" type="number" step="any"/></label>
              <label>实景点经度（°）<input id="tw-gk-lon" type="number" step="any" min="-180" max="180"/></label><label>实景点纬度（°）<input id="tw-gk-lat" type="number" step="any" min="-90" max="90"/></label>
            </div>
            <div class="tw-actions"><button type="button" id="tw-gk-cad">从图纸选复核点</button><button type="button" id="tw-gk-pick">拾取模型同名点</button><button type="button" id="tw-gk-check">查看东、北偏差</button></div>
            <div class="tw-actions"><button type="button" id="tw-gk-apply" disabled>对当前方案应用平移</button><button type="button" id="tw-gk-reset" disabled>恢复原始投影位置</button></div>
            <small class="tw-hint" id="tw-gk-status" role="status">当前使用图纸原始投影位置。</small>
          </details>
          <small id="tw-projection-readout" class="tw-hint">按项目测量资料填写投影参数，选定图元后显示换算位置。</small>
        </div>
      </div>
    </details>
    <div id="tw-overlay-tools" class="tw-overlay-tools">
      <div class="tw-actions"><button type="button" id="tw-place-preview">在摄影模型上预览图纸</button><button type="button" id="tw-place-zoom" disabled>定位到图纸</button><button type="button" id="tw-place-hide" disabled>隐藏图纸预览</button></div>
      <small id="tw-overlay-status" class="tw-hint" data-state="idle" role="status">选择图元并填写坐标后，可预览完整便道中心线或场地轮廓。</small>
    </div>
    <details data-tw-group="glb" open>
      <summary><span class="tw-step">03</span>模型布置 · 建筑底面基准</summary>
      <div class="tw-body">
        <label>布置方式<select id="tw-glb-placement-mode"><option value="cad-auto">按 CAD 闭合轮廓自动布置</option><option value="manual">手动精确坐标与尺寸</option></select></label>
        <p class="tw-hint">请选择驻地或钢筋厂自身的闭合轮廓，勿选整个工地外界；先核对图纸单位、坐标与实测尺寸。生成时沿用已核验的坐标配置，自动计算位置、朝向及长宽，保留原模型高度。矩形轮廓按长宽贴合；异形轮廓寻找完整位于范围内的布置。直接修改以下坐标或尺寸会转为手动模式。</p>
        <div class="tw-actions"><button id="tw-glb-use-boundary" type="button">按图纸轮廓自动布置</button></div>
        <label class="tw-check"><input id="tw-glb-flip" type="checkbox"/>将自动布置的正面反转 180°</label>
        <p id="tw-glb-fit-status" class="tw-hint" role="status">未进行图纸轮廓适配。图纸位置来自所选坐标转换；自动布置不代替坐标配准。</p>
        <div class="tw-grid">
          <label>底面基准经度（°）<input id="tw-glb-lon" type="number" min="-180" max="180" step="any"/></label>
          <label>底面基准纬度（°）<input id="tw-glb-lat" type="number" min="-90" max="90" step="any"/></label>
          <label>底面椭球高（m）<input id="tw-glb-elevation" type="number" step="any"/></label>
          <label>平面旋转（°，东→北）<input id="tw-glb-heading" type="number" step="any" value="0"/></label>
        </div>
        <div class="tw-actions"><button id="tw-glb-pick" type="button">拾取摄影底面位置</button><button id="tw-glb-sample-height" type="button">读取当前位置摄影高程</button></div>
        <p class="tw-hint">自动布置对建筑底面边缘和内部多点采样，以最高有效摄影表面高程安放水平底面。摄影表面含树木等地物，需核验采样高差；刚性建筑不会逐点变形贴地。无摄影时只完成平面适配，须提供实测椭球高才能预览。</p>
        <label>尺寸调整<select id="tw-glb-scale-mode"><option value="uniform">等比例缩放</option><option value="xyz">高级 · XYZ 独立缩放</option></select></label>
        <div class="tw-grid">
          <label>目标长度 X（m）<input id="tw-glb-length" type="number" min="0" step="any"/></label>
          <label>目标宽度 Z（m）<input id="tw-glb-width" type="number" min="0" step="any"/></label>
          <label>目标高度 Y（m）<input id="tw-glb-height" type="number" min="0" step="any"/></label>
        </div>
        <div class="tw-actions"><button id="tw-glb-reset-size" type="button">恢复核验原尺寸</button><button id="tw-glb-cancel-edit" type="button" hidden>退出编辑</button></div>
      </div>
    </details>
    <details data-tw-group="glb" open>
      <summary><span class="tw-step">04</span>企业标识与摄影遮挡</summary>
      <div class="tw-body">
        <label class="tw-check"><input id="tw-glb-brand-visible" type="checkbox"/>显示独立可替换宣传文字 / LOGO</label>
        <label>宣传文字<textarea id="tw-glb-brand-text" maxlength="200" rows="2">东方雄师 铁建劲旅
编制经纬 筑梦城市</textarea></label>
        <label>替换中铁二十四局 LOGO 图片<input id="tw-glb-logo" type="file" accept="image/png,image/jpeg,image/webp"/></label>
        <div class="tw-actions"><button id="tw-glb-clear-logo" type="button">移除附加 LOGO</button></div>
        <p class="tw-hint">默认采用提供模型中的中铁二十四局 LOGO，支持上传替换或移除。宣传墙与文字独立管理，原模型的国旗与安全警示保留。</p>
        <label class="tw-check"><input id="tw-glb-clipping" type="checkbox" checked/>按建筑底面自动遮挡所选摄影模型</label>
        <p id="tw-glb-clip-status" class="tw-hint" role="status">显示、隐藏与删除会同步更新对应摄影遮挡。</p>
      </div>
    </details>
    <details id="tw-lighting-section" open>
      <summary>临建模型亮度</summary>
      <div class="tw-body">
        <label>统一亮度 <output id="tw-brightness-value">100%</output><input id="tw-brightness" type="range" min="50" max="200" step="1" value="100"/></label>
        <div class="tw-actions"><button id="tw-brightness-reset" type="button">恢复默认亮度</button></div>
        <div id="tw-object-brightness-controls" hidden>
          <label>当前模型亮度<select id="tw-object-brightness-mode"><option value="inherit">沿用统一亮度</option><option value="custom">单独设置</option></select></label>
          <label id="tw-object-brightness-field" hidden>单独亮度 <output id="tw-object-brightness-value">100%</output><input id="tw-object-brightness" type="range" min="50" max="200" step="1" value="100"/></label>
          <div class="tw-actions"><button id="tw-object-brightness-save" type="button">保存当前模型亮度</button></div>
        </div>
        <p class="tw-hint">仅调整临建 GLB 模型。统一亮度释放滑条后保存；单独亮度点击“保存当前模型亮度”。偏好保存在当前浏览器、当前项目。</p>
      </div>
    </details>
    <details id="tw-datum-section" hidden>
      <summary><span class="tw-step">03</span>相对高程基准</summary>
      <div class="tw-body">
        <p id="tw-road-datum" class="tw-hint" data-tw-group="road">优先以起点 K0+000.000 的模型表面为 ±0.000。起点缺测时，在半幅路宽内（最远 10 m）就近取高，仍以 K0 为校准桩号。附近也缺测时，改在沿线首个有效路面桩号校准。下方标高填在校准桩号处。</p>
        <p class="tw-hint" data-tw-group="site">选择场地基准点，将其摄影模型表面标高记为 ±0.000。</p>
        <div class="tw-grid tw-baseline" data-tw-group="site">
          <label>基准点输入方式<select id="tw-ref-mode"><option value="cad">规划图 CAD 坐标</option><option value="geo">WGS84 经纬度</option></select></label>
          <button id="tw-pick" type="button">在模型上拾取</button>
          <label><span id="tw-ref-first-label">基准点 CAD X</span><input id="tw-ref-x" type="number" step="any"/></label>
          <label><span id="tw-ref-second-label">基准点 CAD Y</span><input id="tw-ref-y" type="number" step="any"/></label>
        </div>

        <label><span id="tw-finished-label">校准桩号处路面顶相对标高（m）</span><input id="tw-finished" type="number" step="any" placeholder="相对 ±0.000，可为负值"/></label>
      </div>
    </details>
    <details id="tw-design-section" open>
      <summary><span class="tw-step">04</span><span id="tw-section-title">便道断面与分段纵坡</span></summary>
      <div class="tw-body">
        <div data-tw-group="site" class="tw-subgroup">
        <label>典型断面图（可选）<input id="tw-section" type="file" accept="${cadAccept},.pdf,.png,.jpg,.jpeg,.webp"/></label>
        <div class="tw-actions tw-upload-actions"><button id="tw-replace-section" type="button" disabled>更换断面图</button><button id="tw-remove-section" type="button" disabled>移除断面图</button></div>
        <div id="tw-section-preview" class="tw-preview" aria-label="典型断面预览"></div>
        <div data-tw-group="sec-cad" class="tw-subgroup" hidden>
          <div class="tw-grid">
            <label>断面图元<select id="tw-sec-profile"></select></label>
            <label>断面图单位<select id="tw-sec-unit">${lengthUnits}</select></label>
          </div>
          <div class="tw-actions tw-zonal">
            <button id="tw-measure-depth" type="button">从竖线读取面层至处理顶厚度</button>
          </div>
        </div>
        <div id="tw-section-summary" class="tw-hint"></div>
        <p class="tw-hint">断面 CAD 可选择竖直线读取厚度，PDF 或图片可对照原图填写厚度与场地坡度。</p>
        </div>
        <div class="tw-grid">
          <label><span id="tw-hardening-label">硬化层厚度（m）</span><input id="tw-thickness" type="number" min="0" step="any" placeholder="向上叠加厚度"/></label>
          <label><span id="tw-treatment-label">地基处理深度（m）</span><input id="tw-treatment" type="number" min="0" step="any" value="0"/></label>
        </div>
        <p class="tw-hint" data-tw-group="site">另挖深度填 0 时，计量至地基处理顶面。若需挖至处理底面，填写设计处理厚度。</p>
        <div data-tw-group="road" class="tw-subgroup">
          <p class="tw-subtitle">便道横断面</p>
          <label>起点路面顶椭球高（m）<input id="tw-road-elevation" type="number" step="any" placeholder="输入已核准的场景高程，不能直接混用工程标高"/></label>
          <label>路面总宽（m）<input id="tw-width" type="number" min="0" step="any" placeholder="两侧路面边缘之间的水平距离"/></label>
          <div class="tw-grid" hidden>
            <label>路基边坡 · 高<input id="tw-slope-height" type="number" min="0" step="any" value="1"/></label>
            <label>路基边坡 · 宽<input id="tw-slope-width" type="number" min="0" step="any" value="0"/></label>
          </div>
          <p class="tw-hint">从设计路面顶向下生成硬化层和处理层，厚度按竖向距离控制。无需全线摄影取高，树冠、水面不会改变道路标高。</p>
          <div id="tw-road-section-preview"></div>
          <label class="tw-check"><input id="tw-road-grades-enabled" type="checkbox"/>设置分段纵坡</label>
          <p class="tw-hint">关闭时按起点顶标高生成水平便道；开启后按里程连续计算高程，保留原 CAD 弧长。</p>
          <div id="tw-road-grade-editor" hidden>
          <div class="tw-grade-grid tw-grade-head"><span>起里程（m）</span><span>止里程（m）</span><span>纵坡（%）</span><span></span></div>
          <div id="tw-grades"></div>
          <button type="button" id="tw-add-grade" disabled>添加里程段</button>
          </div>
          <p id="tw-grade-status" class="tw-hint" role="status"></p>
          <label class="tw-check"><input id="tw-road-clipping" type="checkbox" checked/>遮挡便道实际占地内的所选倾斜摄影</label>
          <button id="tw-road-cancel-edit" type="button" hidden>退出便道编辑</button>
        </div>
        <div data-tw-group="site" class="tw-subgroup">
          <p class="tw-subtitle">闭合范围的设计面</p>
          <div class="tw-grid">
            <label>向东坡度（%）<input id="tw-grade-east" type="number" step="any" value="0"/></label>
            <label>向北坡度（%）<input id="tw-grade-north" type="number" step="any" value="0"/></label>
          </div>
          <p class="tw-hint">沿对应方向升高时取正，两个坡度均为 0 时按水平硬化面计算。</p>
        </div>
        <label class="tw-check tw-confirm"><input id="tw-confirmed" type="checkbox"/>已核对设计标高、路宽、结构厚度与纵坡</label>
      </div>
    </details>
    <details open>
      <summary><span class="tw-step">05</span>预览与状态</summary>
      <div class="tw-body">
        <label hidden>历史采样间距（m）<input id="tw-grid" type="number" min="0" step="any" value="2"/></label>
        <p data-tw-group="road" class="tw-hint">按用户标高和可选纵坡生成完整便道；摄影遮挡不等于场地接顺，请从侧面核对外围高差。</p>
        <label class="tw-check"><input type="checkbox" id="tw-xray"/>透视显示埋入原地面的设计面</label>
        <div id="tw-draft-actions" class="tw-actions" hidden><button type="button" id="tw-draft-drawing" data-tw-group="road">查看完整 CAD 中心线</button><button type="button" id="tw-draft-visibility">隐藏模型预览</button><button type="button" id="tw-discard-draft">移除模型预览</button></div>
        <div id="tw-metrics" class="tw-metrics" aria-live="polite"></div>
      </div>
    </details>
    <div class="tw-records">
      <h3>06 · 已保存方案</h3>
      <section id="tw-position-controls" class="tw-position-controls" aria-label="临建设施位置调整" hidden>
        <strong id="tw-position-title">位置调整</strong>
        <div class="tw-grid">
          <label>平移步长（m）<input id="tw-position-step" type="number" min="0.01" max="1000" step="any" value="1"/></label>
          <label>升降步长（m）<input id="tw-position-height-step" type="number" min="0.01" max="1000" step="any" value="0.1"/></label>
        </div>
        <label>平移方向<select id="tw-position-axis"><option value="view">按当前视角前后左右</option><option value="north">按地图方向（上北下南）</option></select></label>
        <div class="tw-position-pad">
          <button id="tw-position-forward" type="button">↑ 前移</button>
          <button id="tw-position-left" type="button">← 左移</button>
          <button id="tw-position-back" type="button">↓ 后移</button>
          <button id="tw-position-right" type="button">右移 →</button>
        </div>
        <div class="tw-actions"><button id="tw-position-up" type="button">＋ 升高</button><button id="tw-position-down" type="button">－ 降低</button><button id="tw-position-reset" type="button">恢复调整前位置</button></div>
        <p id="tw-position-offset" class="tw-hint" role="status"></p>
        <p class="tw-hint">整体移动并保留形状、坡度和厚度。相邻硬化自动更新；历史摄影采样与土方需在新位置重新核算。</p>
        <div class="tw-actions"><button id="tw-position-save" type="button" class="tw-primary">保存位置</button><button id="tw-position-cancel" type="button">取消调整</button></div>
      </section>
      <div id="tw-plans" class="tw-plans"></div>
    </div>
  </div>

  <div class="tw-foot">
    <div id="tw-status" class="tw-status" role="status" aria-live="polite">选择模型，导入 CAD 平面规划图。</div>
    <div class="tw-actions"><button id="tw-run" type="button" class="tw-primary">生成并预览</button><button id="tw-cancel" type="button" disabled>取消</button><button id="tw-save" type="button" disabled>保存方案</button></div>
  </div>
</div>`;
