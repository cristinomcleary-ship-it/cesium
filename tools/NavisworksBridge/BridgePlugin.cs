using System;
using System.IO;
using System.Linq;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.ComApi;
using Autodesk.Navisworks.Api.Interop.ComApi;
using Autodesk.Navisworks.Api.Plugins;
using ComApi = Autodesk.Navisworks.Api.Interop.ComApi;

namespace CesiumNavisworksBridge
{
    [Plugin("CesiumModelBridge", "Codex", DisplayName = "Cesium Model Bridge", ToolTip = "Exports the active model for local Cesium conversion")]
    [AddInPlugin(AddInLocation.AddIn)]
    public class BridgePlugin : AddInPlugin
    {
        public override int Execute(params string[] parameters)
        {
            if (parameters == null || parameters.Length < 2) return 2;
            var command = parameters[0];
            var output = parameters[1];
            if (string.Equals(command, "list", StringComparison.OrdinalIgnoreCase))
            {
                File.WriteAllLines(output, Application.Plugins.PluginRecords.Select(record => record.Id).OrderBy(id => id));
                return 0;
            }
            if (!string.Equals(command, "export-fbx", StringComparison.OrdinalIgnoreCase)) return 3;

            var state = ComApiBridge.State;
            var candidates = new[] { "lcodpfbx", "FbxExportPlugin", "FbxExport" };
            Exception lastError = null;
            foreach (var pluginName in candidates)
            {
                try
                {
                    ComApi.InwOaPropertyVec options = state.GetIOPluginOptions(pluginName);
                    var status = state.DriveIOPlugin(pluginName, output, options);
                    if (File.Exists(output) && new FileInfo(output).Length > 0) return 0;
                    lastError = new InvalidOperationException("FBX plug-in returned status " + status);
                }
                catch (Exception error) { lastError = error; }
            }
            File.WriteAllText(output + ".error.txt", lastError == null ? "No FBX export plug-in was available." : lastError.ToString());
            return 4;
        }
    }
}
