using System;
using System.IO;
using Autodesk.Navisworks.Api.Automation;

namespace CesiumNavisworksBridge
{
    internal static class BridgeRunner
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("Usage: BridgeRunner.exe <input> <output.fbx> <plugin.dll>");
                return 2;
            }
            NavisworksApplication application = null;
            var log = args[1] + ".bridge.log";
            try
            {
                File.AppendAllText(log, DateTime.Now + " Starting Navisworks Automation" + Environment.NewLine);
                application = new NavisworksApplication();
                File.AppendAllText(log, DateTime.Now + " Automation ready" + Environment.NewLine);
                application.DisableProgress();
                application.AddPluginAssembly(args[2]);
                File.AppendAllText(log, DateTime.Now + " Plug-in loaded" + Environment.NewLine);
                if (args[0] == "--list")
                {
                    return application.ExecuteAddInPlugin("CesiumModelBridge.Codex", "list", args[1]);
                }
                application.OpenFile(args[0], new string[0]);
                File.AppendAllText(log, DateTime.Now + " Source opened" + Environment.NewLine);
                var result = application.ExecuteAddInPlugin("CesiumModelBridge.Codex", "export-fbx", args[1]);
                File.AppendAllText(log, DateTime.Now + " Export returned " + result + Environment.NewLine);
                return result;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                try { File.AppendAllText(log, error + Environment.NewLine); } catch { }
                return 1;
            }
            finally
            {
                if (application != null)
                {
                    try { application.Dispose(); } catch { }
                }
            }
        }
    }
}
