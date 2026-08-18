using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Gmgn985Updater
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            if (args.Length > 0 && args[0].StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase))
            {
                NativeHost.Run(args[0]);
                return;
            }

            if (args.Length > 0 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                Environment.ExitCode = SelfTest.Run();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }

    internal static class ProductInfo
    {
        internal const string ExtensionId = "bdhjiabmohplopjledcagfaejbgdeonf";
        internal const string ExtensionOrigin = "chrome-extension://bdhjiabmohplopjledcagfaejbgdeonf/";
        internal const string NativeHostName = "com.xuezhang985.gmgn_helper";
        internal const string Repository = "0xuezhang985/985gmgn-helper";
        internal const string LatestReleaseApi = "https://api.github.com/repos/0xuezhang985/985gmgn-helper/releases/latest";
        internal const string ReleasesPage = "https://github.com/0xuezhang985/985gmgn-helper/releases/latest";
        internal const string ManifestKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAotBvFq65NLPkl/sfJPAOUsAY3wrS4I0WOVQ4K8D6Vy9tZyNnRoDrntLCxiJnlJQ88+jPsBmpgL3/Km3dqUFzJnmPqlgbCFrzCWXi6YaX6lqYFAip0MUOPnNogNkY6flkwP+NurfV8Hf5ZlXnN/moR9DmdN15M9Qg390yqIhQFapxozPGZUbj1vHyCiJJ6fHo48DLfJHNhixAa/LLUF6msICVgDyfU/Rnj7RWEWbpUhA0CcQzUa5MY14IcS4Ktkegb6FGNgUa2p/g2+OjIBGIvAYvVGNgYuwN9GGdA5mx+PPxRwKegne0tFrX7Irzk4xG9A2LiTIkzaWjcptRrP+01QIDAQAB";

        internal static readonly string InstallRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "985gmgn-helper"
        );
        internal static readonly string ExtensionPath = Path.Combine(InstallRoot, "Extension");
        internal static readonly string UpdaterPath = Path.Combine(InstallRoot, "985gmgn-updater.exe");
        internal static readonly string HostManifestPath = Path.Combine(InstallRoot, "native-host.json");
        internal static readonly string ConfigPath = Path.Combine(InstallRoot, "install.json");
        internal static readonly string BackupsPath = Path.Combine(InstallRoot, "Backups");

        internal static readonly HashSet<string> ExtensionFiles = new HashSet<string>(
            new[]
            {
                "manifest.json",
                "background.js",
                "page-bridge.js",
                "content.js",
                "styles.css",
                "popup.html",
                "popup.css",
                "popup.js",
                "icons/icon16.png",
                "icons/icon32.png",
                "icons/icon48.png",
                "icons/icon128.png"
            },
            StringComparer.OrdinalIgnoreCase
        );
    }

    internal static class Json
    {
        internal static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = 4 * 1024 * 1024
        };

        internal static Dictionary<string, object> Object(params object[] values)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            for (int i = 0; i + 1 < values.Length; i += 2)
            {
                result[(string)values[i]] = values[i + 1];
            }
            return result;
        }

        internal static string StringValue(Dictionary<string, object> value, string key)
        {
            object raw;
            return value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw, CultureInfo.InvariantCulture) : string.Empty;
        }
    }

    internal static class NativeHost
    {
        internal static void Run(string origin)
        {
            Stream output = Console.OpenStandardOutput();
            try
            {
                if (!string.Equals(origin, ProductInfo.ExtensionOrigin, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("拒绝未授权的扩展来源");
                }

                Dictionary<string, object> request = ReadMessage(Console.OpenStandardInput());
                string action = Json.StringValue(request, "action");
                Dictionary<string, object> response;

                if (string.Equals(action, "check", StringComparison.OrdinalIgnoreCase))
                {
                    response = UpdateService.Check(Json.StringValue(request, "currentVersion"));
                }
                else if (string.Equals(action, "update", StringComparison.OrdinalIgnoreCase))
                {
                    response = UpdateService.Update();
                }
                else
                {
                    throw new InvalidOperationException("不支持的操作");
                }

                WriteMessage(output, response);
            }
            catch (Exception ex)
            {
                WriteMessage(output, Json.Object("ok", false, "error", FriendlyError(ex)));
            }
        }

        private static Dictionary<string, object> ReadMessage(Stream input)
        {
            byte[] lengthBytes = ReadExact(input, 4);
            int length = BitConverter.ToInt32(lengthBytes, 0);
            if (length <= 0 || length > 1024 * 1024)
            {
                throw new InvalidDataException("Native Messaging 消息长度无效");
            }
            byte[] payload = ReadExact(input, length);
            Dictionary<string, object> message = Json.Serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
            if (message == null) throw new InvalidDataException("Native Messaging 消息格式无效");
            return message;
        }

        private static byte[] ReadExact(Stream input, int length)
        {
            byte[] buffer = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int read = input.Read(buffer, offset, length - offset);
                if (read <= 0) throw new EndOfStreamException("Native Messaging 输入不完整");
                offset += read;
            }
            return buffer;
        }

        private static void WriteMessage(Stream output, Dictionary<string, object> response)
        {
            byte[] payload = Encoding.UTF8.GetBytes(Json.Serializer.Serialize(response));
            byte[] lengthBytes = BitConverter.GetBytes(payload.Length);
            output.Write(lengthBytes, 0, lengthBytes.Length);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }

        private static string FriendlyError(Exception error)
        {
            WebException webError = error as WebException;
            if (webError != null) return "无法连接 GitHub，请检查网络后重试";
            return string.IsNullOrWhiteSpace(error.Message) ? "更新器发生未知错误" : error.Message;
        }
    }

    internal sealed class ReleaseInfo
    {
        internal string Version;
        internal string ReleaseUrl;
        internal string ZipName;
        internal string ZipUrl;
        internal string ZipDigest;
        internal string ChecksumUrl;
    }

    internal static class UpdateService
    {
        internal static Dictionary<string, object> Check(string currentVersion)
        {
            if (!VersionTools.IsValid(currentVersion)) throw new InvalidDataException("当前插件版本号无效");
            ReleaseInfo release = GetLatestRelease();
            bool available = VersionTools.Compare(release.Version, currentVersion) > 0;
            return Json.Object(
                "ok", true,
                "updateAvailable", available,
                "currentVersion", currentVersion,
                "latestVersion", release.Version,
                "releaseUrl", release.ReleaseUrl
            );
        }

        internal static Dictionary<string, object> Update()
        {
            EnsureInstalled();
            // 装坏了就读不出版本号，此时当作 0.0.0：任何线上版本都算更新，从而顺带把目录修好，
            // 而不是卡在「插件缺少 manifest.json」上连升级也走不了。
            string installedVersion = ExtensionPackage.TryReadManifestVersion(ProductInfo.ExtensionPath) ?? "0.0.0";
            ReleaseInfo release = GetLatestRelease();
            if (VersionTools.Compare(release.Version, installedVersion) <= 0)
            {
                return Json.Object(
                    "ok", true,
                    "updated", false,
                    "updatedVersion", installedVersion,
                    "releaseUrl", release.ReleaseUrl
                );
            }

            string tempRoot = Path.Combine(Path.GetTempPath(), "985gmgn-update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            try
            {
                byte[] zipBytes = DownloadBytes(release.ZipUrl);
                string actualHash = HashTools.Sha256(zipBytes);
                VerifyReleaseHash(release, actualHash);

                string zipPath = Path.Combine(tempRoot, release.ZipName);
                File.WriteAllBytes(zipPath, zipBytes);
                string stagedPath = Path.Combine(tempRoot, "Extension");
                ExtensionPackage.ExtractValidated(zipPath, stagedPath, release.Version);
                ExtensionPackage.ReplaceInstalled(stagedPath, installedVersion);
                WriteInstallConfig(release.Version);
                CleanupOldBackups();

                return Json.Object(
                    "ok", true,
                    "updated", true,
                    "updatedVersion", release.Version,
                    "releaseUrl", release.ReleaseUrl,
                    "sha256", actualHash
                );
            }
            finally
            {
                TryDeleteDirectory(tempRoot);
            }
        }

        internal static string InstallEmbeddedPackage(string runningExecutable)
        {
            Directory.CreateDirectory(ProductInfo.InstallRoot);
            Directory.CreateDirectory(ProductInfo.BackupsPath);

            string tempRoot = Path.Combine(Path.GetTempPath(), "985gmgn-install-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            try
            {
                string zipPath = Path.Combine(tempRoot, "extension.zip");
                using (Stream resource = typeof(Program).Assembly.GetManifestResourceStream("ExtensionPackage.zip"))
                {
                    if (resource == null) throw new InvalidDataException("安装器内缺少插件安装包");
                    using (FileStream output = File.Create(zipPath)) resource.CopyTo(output);
                }

                string stagedPath = Path.Combine(tempRoot, "Extension");
                string version = ExtensionPackage.ExtractValidated(zipPath, stagedPath, null);
                // 旧目录残缺时（装到一半中断、被杀毒清理、或只是点过「打开插件目录」建出的空目录）
                // 读不出版本号。这种情况恰恰最需要修复，不能让它把安装挡下来——版本号只用于备份命名。
                string previousVersion = ExtensionPackage.TryReadManifestVersion(ProductInfo.ExtensionPath);
                ExtensionPackage.ReplaceInstalled(stagedPath, previousVersion);

                string currentFullPath = Path.GetFullPath(runningExecutable);
                string targetFullPath = Path.GetFullPath(ProductInfo.UpdaterPath);
                if (!string.Equals(currentFullPath, targetFullPath, StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(currentFullPath, targetFullPath, true);
                }

                WriteNativeHostManifest();
                RegisterNativeHost();
                WriteInstallConfig(version);
                CleanupOldBackups();
                return version;
            }
            finally
            {
                TryDeleteDirectory(tempRoot);
            }
        }

        private static ReleaseInfo GetLatestRelease()
        {
            Dictionary<string, object> release = Json.Serializer.Deserialize<Dictionary<string, object>>(DownloadString(ProductInfo.LatestReleaseApi));
            if (release == null) throw new InvalidDataException("GitHub Release 返回格式无效");

            string version = Json.StringValue(release, "tag_name").TrimStart('v', 'V');
            if (!VersionTools.IsValid(version)) throw new InvalidDataException("GitHub Release 版本号无效");
            string expectedZipName = "985gmgn-helper-v" + version + ".zip";
            string expectedChecksumName = expectedZipName + ".sha256";

            ReleaseInfo result = new ReleaseInfo
            {
                Version = version,
                ReleaseUrl = SafeReleaseUrl(Json.StringValue(release, "html_url")),
                ZipName = expectedZipName
            };

            object rawAssets;
            if (!release.TryGetValue("assets", out rawAssets)) throw new InvalidDataException("GitHub Release 没有安装包");
            IEnumerable assets = rawAssets as IEnumerable;
            if (assets == null) throw new InvalidDataException("GitHub Release 安装包格式无效");

            foreach (object rawAsset in assets)
            {
                Dictionary<string, object> asset = rawAsset as Dictionary<string, object>;
                if (asset == null) continue;
                string name = Json.StringValue(asset, "name");
                if (string.Equals(name, expectedZipName, StringComparison.OrdinalIgnoreCase))
                {
                    result.ZipUrl = SafeAssetUrl(Json.StringValue(asset, "browser_download_url"));
                    result.ZipDigest = Json.StringValue(asset, "digest");
                }
                else if (string.Equals(name, expectedChecksumName, StringComparison.OrdinalIgnoreCase))
                {
                    result.ChecksumUrl = SafeAssetUrl(Json.StringValue(asset, "browser_download_url"));
                }
            }

            if (string.IsNullOrEmpty(result.ZipUrl)) throw new InvalidDataException("GitHub Release 缺少 " + expectedZipName);
            if (string.IsNullOrEmpty(result.ZipDigest) && string.IsNullOrEmpty(result.ChecksumUrl))
            {
                throw new InvalidDataException("GitHub Release 缺少 SHA256 校验信息");
            }
            return result;
        }

        private static void VerifyReleaseHash(ReleaseInfo release, string actualHash)
        {
            if (!string.IsNullOrEmpty(release.ZipDigest))
            {
                string digest = release.ZipDigest;
                if (digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase)) digest = digest.Substring(7);
                if (!HashTools.IsSha256(digest) || !string.Equals(digest, actualHash, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("GitHub 安装包 SHA256 校验失败");
                }
            }

            if (!string.IsNullOrEmpty(release.ChecksumUrl))
            {
                string checksum = DownloadString(release.ChecksumUrl).Trim().Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0];
                if (!HashTools.IsSha256(checksum) || !string.Equals(checksum, actualHash, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("校验文件与安装包不匹配");
                }
            }
        }

        private static string DownloadString(string url)
        {
            using (WebClient client = CreateWebClient()) return client.DownloadString(url);
        }

        private static byte[] DownloadBytes(string url)
        {
            using (WebClient client = CreateWebClient()) return client.DownloadData(url);
        }

        private static WebClient CreateWebClient()
        {
            WebClient client = new WebClient();
            client.Encoding = Encoding.UTF8;
            client.Headers[HttpRequestHeader.UserAgent] = "985gmgn-updater/1.0";
            client.Headers[HttpRequestHeader.Accept] = "application/vnd.github+json";
            return client;
        }

        private static string SafeReleaseUrl(string url)
        {
            const string prefix = "https://github.com/0xuezhang985/985gmgn-helper/releases/";
            return url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? url : ProductInfo.ReleasesPage;
        }

        private static string SafeAssetUrl(string url)
        {
            const string prefix = "https://github.com/0xuezhang985/985gmgn-helper/releases/download/";
            if (!url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("拒绝非官方仓库的下载地址");
            return url;
        }

        private static void EnsureInstalled()
        {
            if (!File.Exists(ProductInfo.ConfigPath) || !Directory.Exists(ProductInfo.ExtensionPath))
            {
                throw new InvalidOperationException("本地安装信息缺失，请重新运行 985gmgn助手安装器");
            }
        }

        private static void WriteNativeHostManifest()
        {
            Dictionary<string, object> manifest = Json.Object(
                "name", ProductInfo.NativeHostName,
                "description", "985gmgn助手本地更新器",
                "path", ProductInfo.UpdaterPath,
                "type", "stdio",
                "allowed_origins", new[] { ProductInfo.ExtensionOrigin }
            );
            File.WriteAllText(ProductInfo.HostManifestPath, Json.Serializer.Serialize(manifest), new UTF8Encoding(false));
        }

        private static void RegisterNativeHost()
        {
            string[] registryPaths =
            {
                @"Software\Google\Chrome\NativeMessagingHosts\" + ProductInfo.NativeHostName,
                @"Software\Microsoft\Edge\NativeMessagingHosts\" + ProductInfo.NativeHostName
            };
            foreach (string registryPath in registryPaths)
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(registryPath))
                {
                    if (key == null) throw new InvalidOperationException("无法注册 Native Messaging 主机");
                    key.SetValue(string.Empty, ProductInfo.HostManifestPath, RegistryValueKind.String);
                }
            }
        }

        private static void WriteInstallConfig(string version)
        {
            Dictionary<string, object> config = Json.Object(
                "extensionId", ProductInfo.ExtensionId,
                "extensionPath", ProductInfo.ExtensionPath,
                "version", version,
                "installedAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            );
            File.WriteAllText(ProductInfo.ConfigPath, Json.Serializer.Serialize(config), new UTF8Encoding(false));
        }

        private static void CleanupOldBackups()
        {
            if (!Directory.Exists(ProductInfo.BackupsPath)) return;
            DirectoryInfo[] backups = new DirectoryInfo(ProductInfo.BackupsPath).GetDirectories();
            Array.Sort(backups, delegate(DirectoryInfo left, DirectoryInfo right)
            {
                return right.CreationTimeUtc.CompareTo(left.CreationTimeUtc);
            });
            for (int i = 3; i < backups.Length; i++) TryDeleteDirectory(backups[i].FullName);
        }

        internal static void TryDeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
            catch
            {
            }
        }
    }

    internal static class ExtensionPackage
    {
        internal static string ExtractValidated(string zipPath, string destinationPath, string expectedVersion)
        {
            Directory.CreateDirectory(destinationPath);
            string destinationRoot = Path.GetFullPath(destinationPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            HashSet<string> extracted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long totalBytes = 0;

            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relativePath = entry.FullName.Replace('\\', '/').TrimStart('/');
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    if (!ProductInfo.ExtensionFiles.Contains(relativePath))
                    {
                        throw new InvalidDataException("安装包包含未授权文件：" + relativePath);
                    }
                    if (!extracted.Add(relativePath)) throw new InvalidDataException("安装包包含重复文件：" + relativePath);

                    totalBytes += entry.Length;
                    if (entry.Length > 20 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024)
                    {
                        throw new InvalidDataException("安装包体积异常");
                    }

                    string targetPath = Path.GetFullPath(Path.Combine(destinationPath, relativePath.Replace('/', Path.DirectorySeparatorChar)));
                    if (!targetPath.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("安装包路径越界");
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
                    using (Stream input = entry.Open())
                    using (FileStream output = File.Create(targetPath)) input.CopyTo(output);
                }
            }

            foreach (string requiredFile in ProductInfo.ExtensionFiles)
            {
                if (!extracted.Contains(requiredFile)) throw new InvalidDataException("安装包缺少文件：" + requiredFile);
            }
            return ReadManifestVersion(destinationPath, expectedVersion);
        }

        /// <summary>读不出版本号就返回 null（目录不存在、缺 manifest、内容损坏都算），不抛异常。</summary>
        internal static string TryReadManifestVersion(string extensionPath)
        {
            if (!Directory.Exists(extensionPath)) return null;
            try
            {
                return ReadManifestVersion(extensionPath, null);
            }
            catch
            {
                return null;
            }
        }

        internal static string ReadManifestVersion(string extensionPath, string expectedVersion)
        {
            string manifestPath = Path.Combine(extensionPath, "manifest.json");
            if (!File.Exists(manifestPath)) throw new InvalidDataException("插件缺少 manifest.json");
            Dictionary<string, object> manifest = Json.Serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath, Encoding.UTF8));
            if (manifest == null) throw new InvalidDataException("manifest.json 格式无效");
            string name = Json.StringValue(manifest, "name");
            string key = Json.StringValue(manifest, "key");
            string version = Json.StringValue(manifest, "version");
            if (!string.Equals(name, "985gmgn助手", StringComparison.Ordinal)) throw new InvalidDataException("插件名称校验失败");
            if (!string.Equals(key, ProductInfo.ManifestKey, StringComparison.Ordinal)) throw new InvalidDataException("插件固定 ID 校验失败");
            if (!VersionTools.IsValid(version)) throw new InvalidDataException("插件版本号无效");
            if (!string.IsNullOrEmpty(expectedVersion) && !string.Equals(version, expectedVersion, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("安装包版本与 GitHub Release 不一致");
            }
            return version;
        }

        internal static void ReplaceInstalled(string stagedPath, string previousVersion)
        {
            Directory.CreateDirectory(ProductInfo.BackupsPath);
            string backupPath = null;
            if (Directory.Exists(ProductInfo.ExtensionPath))
            {
                string safeVersion = string.IsNullOrEmpty(previousVersion) ? "unknown" : previousVersion;
                backupPath = Path.Combine(ProductInfo.BackupsPath, safeVersion + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
                Directory.Move(ProductInfo.ExtensionPath, backupPath);
            }

            try
            {
                Directory.Move(stagedPath, ProductInfo.ExtensionPath);
            }
            catch
            {
                if (Directory.Exists(ProductInfo.ExtensionPath)) UpdateService.TryDeleteDirectory(ProductInfo.ExtensionPath);
                if (!string.IsNullOrEmpty(backupPath) && Directory.Exists(backupPath)) Directory.Move(backupPath, ProductInfo.ExtensionPath);
                throw;
            }
        }
    }

    internal static class VersionTools
    {
        internal static bool IsValid(string value)
        {
            Version version;
            return Version.TryParse(value, out version) && version.Major >= 0;
        }

        internal static int Compare(string left, string right)
        {
            Version leftVersion;
            Version rightVersion;
            if (!Version.TryParse(left, out leftVersion) || !Version.TryParse(right, out rightVersion))
            {
                throw new InvalidDataException("版本号格式无效");
            }
            return leftVersion.CompareTo(rightVersion);
        }
    }

    internal static class HashTools
    {
        internal static string Sha256(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return ToHex(sha.ComputeHash(bytes));
            }
        }

        internal static bool IsSha256(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length != 64) return false;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
            }
            return true;
        }

        private static string ToHex(byte[] bytes)
        {
            StringBuilder result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return result.ToString();
        }
    }

    internal sealed class InstallerForm : Form
    {
        private readonly Label statusLabel;
        private readonly Button installButton;
        private readonly Label stepsLabel;
        private readonly TextBox pathBox;

        internal InstallerForm()
        {
            Text = "985gmgn助手安装器";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(540, 494);
            MinimumSize = new Size(556, 533);
            BackColor = Color.FromArgb(17, 19, 24);
            ForeColor = Color.FromArgb(244, 246, 248);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;

            Label title = new Label
            {
                Text = "985gmgn助手",
                Font = new Font("Microsoft YaHei UI", 20F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.White,
                AutoSize = true,
                Location = new Point(28, 24)
            };
            Controls.Add(title);

            Label version = new Label
            {
                Text = "安装器 v" + Application.ProductVersion,
                AutoSize = true,
                ForeColor = Color.FromArgb(144, 151, 163),
                Location = new Point(31, 66)
            };
            Controls.Add(version);

            Label description = new Label
            {
                Text = "安装插件文件和本地更新器，并注册 Chrome / Edge Native Messaging。\r\n本程序不会常驻后台，只在安装或插件请求升级时运行。",
                AutoSize = false,
                Size = new Size(478, 52),
                ForeColor = Color.FromArgb(199, 204, 212),
                Location = new Point(31, 101)
            };
            Controls.Add(description);

            statusLabel = new Label
            {
                Text = DetectInstallStatus(),
                AutoEllipsis = true,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(24, 27, 33),
                ForeColor = Color.FromArgb(174, 180, 191),
                Padding = new Padding(10, 9, 10, 8),
                Size = new Size(478, 44),
                Location = new Point(31, 155)
            };
            Controls.Add(statusLabel);

            installButton = MakeButton("安装 / 修复", new Point(31, 219), new Size(478, 42), true);
            installButton.Click += InstallButtonClick;
            Controls.Add(installButton);

            Label pathTitle = new Label
            {
                Text = "插件目录（加载时把这个路径粘进去）",
                AutoSize = true,
                ForeColor = Color.FromArgb(144, 151, 163),
                Location = new Point(31, 272)
            };
            Controls.Add(pathTitle);

            // 路径必须看得见、能选中、能复制：用户卡住的正是「加载插件时找不到目录」这一步
            pathBox = new TextBox
            {
                Text = ProductInfo.ExtensionPath,
                ReadOnly = true,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.FromArgb(24, 27, 33),
                ForeColor = Color.FromArgb(230, 233, 238),
                Size = new Size(360, 24),
                Location = new Point(31, 294)
            };
            pathBox.Click += delegate { pathBox.SelectAll(); };
            Controls.Add(pathBox);

            Button copyButton = MakeButton("复制路径", new Point(399, 292), new Size(110, 27), false);
            copyButton.Click += delegate { CopyExtensionPath(true); };
            Controls.Add(copyButton);

            stepsLabel = new Label
            {
                Text = StepsText(ExtensionPackage.TryReadManifestVersion(ProductInfo.ExtensionPath) != null
                    ? "还要在浏览器里加载它（路径见上方，可点「复制路径」）："
                    : "装完后还需要在浏览器里加载一次："),
                AutoSize = false,
                Size = new Size(478, 92),
                ForeColor = Color.FromArgb(174, 180, 191),
                Location = new Point(31, 330)
            };
            Controls.Add(stepsLabel);

            Button folderButton = MakeButton("打开插件目录", new Point(31, 434), new Size(230, 34), false);
            folderButton.Click += delegate { CopyExtensionPath(true); OpenExtensionFolder(); };
            Controls.Add(folderButton);

            Button extensionsButton = MakeButton("打开扩展程序页面", new Point(279, 434), new Size(230, 34), false);
            extensionsButton.Click += delegate { OpenExtensionsPage(); };
            Controls.Add(extensionsButton);
        }

        /// <summary>装完之后还要在浏览器里加载一次，这几步是绝大多数人卡住的地方，必须写在窗口里。</summary>
        private static string StepsText(string head)
        {
            string[] steps =
            {
                head,
                "① 在扩展程序页面，打开右上角的「开发者模式」开关",
                "② 点左上角「加载已解压的扩展程序」",
                "③ 在弹出的文件夹选择框里按 Ctrl+V 粘贴路径，回车",
                "④ 选中 Extension 文件夹后点「选择文件夹」即可"
            };
            return string.Join(Environment.NewLine, steps);
        }

        private void CopyExtensionPath(bool notify)
        {
            try
            {
                Clipboard.SetText(ProductInfo.ExtensionPath);
                stepsLabel.Text = StepsText("路径已复制到剪贴板，接着做：");
                if (notify)
                {
                    statusLabel.ForeColor = Color.FromArgb(103, 212, 154);
                    statusLabel.Text = "已复制路径，加载时在文件夹选择框里按 Ctrl+V 粘贴即可。";
                }
            }
            catch
            {
                // 剪贴板被别的程序占用时不算失败，路径本来就显示在窗口里
                if (notify)
                {
                    statusLabel.ForeColor = Color.FromArgb(240, 160, 90);
                    statusLabel.Text = "复制失败，请手动选中上面的路径复制。";
                }
            }
        }

        private static Button MakeButton(string text, Point location, Size size, bool primary)
        {
            Button button = new Button
            {
                Text = text,
                Location = location,
                Size = size,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand,
                BackColor = primary ? Color.FromArgb(41, 209, 125) : Color.FromArgb(36, 41, 50),
                ForeColor = primary ? Color.FromArgb(9, 31, 20) : Color.FromArgb(230, 233, 238),
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold, GraphicsUnit.Point)
            };
            button.FlatAppearance.BorderColor = primary ? Color.FromArgb(41, 209, 125) : Color.FromArgb(58, 65, 77);
            return button;
        }

        private void InstallButtonClick(object sender, EventArgs e)
        {
            installButton.Enabled = false;
            statusLabel.ForeColor = Color.FromArgb(245, 184, 61);
            statusLabel.Text = "正在安装，请稍候…";
            Application.DoEvents();
            try
            {
                string version = UpdateService.InstallEmbeddedPackage(Application.ExecutablePath);
                statusLabel.ForeColor = Color.FromArgb(103, 212, 154);
                statusLabel.Text = "文件已装好（v" + version + "）。还差最后一步：在浏览器里加载它，照下面 4 步做。";
                stepsLabel.Text = StepsText("路径已复制到剪贴板，接着做：");
                stepsLabel.ForeColor = Color.FromArgb(230, 233, 238);
                // 路径直接进剪贴板：加载时那个文件夹选择框里粘上去即可，省掉一层层找目录
                CopyExtensionPath(false);
                OpenExtensionFolder();
                OpenExtensionsPage();
            }
            catch (Exception ex)
            {
                statusLabel.ForeColor = Color.FromArgb(255, 127, 133);
                statusLabel.Text = "安装失败：" + ex.Message;
            }
            finally
            {
                installButton.Enabled = true;
            }
        }

        private static string DetectInstallStatus()
        {
            if (!File.Exists(ProductInfo.ConfigPath) || !Directory.Exists(ProductInfo.ExtensionPath))
            {
                return "尚未安装。目标目录：" + ProductInfo.ExtensionPath;
            }
            string installed = ExtensionPackage.TryReadManifestVersion(ProductInfo.ExtensionPath);
            return installed == null
                ? "检测到不完整安装，点击“安装 / 修复”即可直接覆盖恢复，无需手动删除目录。"
                : "已安装插件 v" + installed + "，可执行修复安装。";
        }

        private static void OpenExtensionFolder()
        {
            Directory.CreateDirectory(ProductInfo.ExtensionPath);
            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + ProductInfo.ExtensionPath + "\"") { UseShellExecute = true });
        }

        private static void OpenExtensionsPage()
        {
            // UseShellExecute 会让 chrome:// 这类内部协议走 shell 解析，浏览器可能只开个首页
            // （用户反馈的“弹出浏览器窗口然后没了”）。直接把地址作为命令行参数交给浏览器进程。
            string chrome = FindBrowserExecutable("Google\\Chrome\\Application\\chrome.exe", "chrome.exe");
            if (!string.IsNullOrEmpty(chrome))
            {
                Process.Start(new ProcessStartInfo(chrome, "chrome://extensions/") { UseShellExecute = false });
                return;
            }
            string edge = FindBrowserExecutable("Microsoft\\Edge\\Application\\msedge.exe", "msedge.exe");
            if (!string.IsNullOrEmpty(edge))
            {
                Process.Start(new ProcessStartInfo(edge, "edge://extensions/") { UseShellExecute = false });
                return;
            }
            MessageBox.Show("未找到 Chrome 或 Edge，请手动打开扩展程序管理页面。", "985gmgn助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private static string FindBrowserExecutable(string relativePath, string fileName)
        {
            string[] roots =
            {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)
            };
            foreach (string root in roots)
            {
                string candidate = Path.Combine(root, relativePath);
                if (File.Exists(candidate)) return candidate;
            }
            string appPath = Convert.ToString(Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + fileName, string.Empty, null));
            return File.Exists(appPath) ? appPath : null;
        }
    }

    internal static class SelfTest
    {
        internal static int Run()
        {
            try
            {
                if (!VersionTools.IsValid("0.8.0") || VersionTools.Compare("0.8.1", "0.8.0") <= 0) return 1;
                if (!HashTools.IsSha256(new string('a', 64)) || HashTools.IsSha256("bad")) return 2;
                byte[] publicKey = Convert.FromBase64String(ProductInfo.ManifestKey);
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] digest = sha.ComputeHash(publicKey);
                    StringBuilder extensionId = new StringBuilder(32);
                    for (int i = 0; i < 16; i++)
                    {
                        extensionId.Append((char)('a' + (digest[i] >> 4)));
                        extensionId.Append((char)('a' + (digest[i] & 15)));
                    }
                    if (!string.Equals(extensionId.ToString(), ProductInfo.ExtensionId, StringComparison.Ordinal)) return 3;
                }
                string tempRoot = Path.Combine(Path.GetTempPath(), "985gmgn-selftest-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tempRoot);
                try
                {
                    string zipPath = Path.Combine(tempRoot, "extension.zip");
                    using (Stream resource = typeof(Program).Assembly.GetManifestResourceStream("ExtensionPackage.zip"))
                    {
                        if (resource == null) return 4;
                        using (FileStream output = File.Create(zipPath)) resource.CopyTo(output);
                    }
                    string extractedPath = Path.Combine(tempRoot, "Extension");
                    Version productVersion = new Version(Application.ProductVersion);
                    string expectedVersion = string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}.{1}.{2}",
                        productVersion.Major,
                        productVersion.Minor,
                        productVersion.Build
                    );
                    string version = ExtensionPackage.ExtractValidated(zipPath, extractedPath, expectedVersion);
                    if (!string.Equals(version, expectedVersion, StringComparison.Ordinal)) return 5;
                }
                finally
                {
                    UpdateService.TryDeleteDirectory(tempRoot);
                }
                return 0;
            }
            catch
            {
                return 10;
            }
        }
    }
}
