import { dump } from "src/lib/helps";
import FastSync from "src/main";

async function getClipboardContent(plugin: FastSync): Promise<void> {
  const clipboardReadTipSave = async (owner: string, repo: string, branch: string, token: string, tip: string) => {
    plugin.settings.githubOwner = owner
    plugin.settings.githubRepo = repo
    plugin.settings.githubBranch = branch
    plugin.settings.githubToken = token
    plugin.clipboardReadTip = tip

    await plugin.saveSettings()
    plugin.settingTab.display()

    setTimeout(() => {
      plugin.clipboardReadTip = ""
    }, 2000)
  }

  //
  const clipboardReadTipTipSave = async (tip: string) => {
    plugin.clipboardReadTip = tip

    await plugin.saveData(plugin.settings)
    plugin.settingTab.display()

    setTimeout(() => {
      plugin.clipboardReadTip = ""
    }, 2000)
  }

  try {
    // Check whether the Clipboard API is supported
    if (!navigator.clipboard) {
      return
    }

    // Read clipboard text content
    const text = await navigator.clipboard.readText()

    // Check whether the text is valid JSON
    let parsedData = JSON.parse(text)

    // Check whether the object contains a GitHub configuration
    if (typeof parsedData === "object" && parsedData !== null) {
      const hasOwner = "githubOwner" in parsedData || "owner" in parsedData
      const hasRepo = "githubRepo" in parsedData || "repo" in parsedData
      const hasToken = "githubToken" in parsedData || "token" in parsedData

      if (hasOwner && hasRepo && hasToken) {
        void clipboardReadTipSave(
          parsedData.githubOwner || parsedData.owner,
          parsedData.githubRepo || parsedData.repo,
          parsedData.githubBranch || parsedData.branch || "main",
          parsedData.githubToken || parsedData.token,
          "Configuration pasted into settings!",
        )
        return
      }
    }
    void clipboardReadTipTipSave("No configuration detected!")
    return
  } catch (err) {
    dump(err)
    void clipboardReadTipTipSave("No configuration detected!")
    return
  }
}

const handleClipboardClick = (plugin: FastSync) => { getClipboardContent(plugin).catch(err => { dump(err); }); };

export const SettingsView = ({ plugin }: { plugin: FastSync }) => {
  return (
    <>
      <div className="setting-item">
        <div className="setting-item-info">
          <div className="setting-item-name">GitHub sync configuration</div>
          <div className="setting-item-description">Sync using the GitHub API</div>
        </div>
      </div>
      <div>
        <table className="obsidian-github-sync-multi-platform-settings-openapi">
          <thead>
            <tr>
              <th>Method</th>
              <th>Description</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>GitHub</td>
              <td>Use a GitHub repository to store and sync notes</td>
              <td>
                <a href="https://github.com/settings/tokens">GitHub PAT Settings</a>
              </td>
            </tr>

          </tbody>
        </table>
      </div>
      <div className="clipboard-read">
        <button className="clipboard-read-button" onClick={() => handleClipboardClick(plugin)}>
          Paste remote configuration
        </button>
        <div className="clipboard-read-description">{plugin.clipboardReadTip}</div>
      </div>
    </>
  )
}
