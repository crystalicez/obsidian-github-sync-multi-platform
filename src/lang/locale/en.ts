// English locale
import type { LangMap } from "../lang";

const en: Partial<LangMap> = {
  // General
  "Sync all notes (overwrite remote)": "Sync all notes (overwrite remote)",
  "Sync all notes": "Sync all notes",
  "Remote": "Remote",

  // Clipboard paste feedback
  "Configuration pasted into settings!": "Configuration pasted into settings!",
  "No configuration detected!": "No configuration detected!",

  // Connection info table
  "Method": "Method",
  "Description": "Description",
  "Details": "Details",
  "Use a GitHub repository to store and sync notes": "Use a GitHub repository to store and sync notes",
  "Paste remote configuration": "Paste remote configuration",

  // General settings
  "Enable synchronization": "Enable synchronization",
  "After closing, your notes will not be synced.": "After closing, your notes will not be synced.",
  "Show sync status in status bar": "Show sync status in status bar",
  "Display real-time sync progress, last sync time, or errors in the Obsidian status bar. Disable (kill-switch) to save system resources.": "Display real-time sync progress, last sync time, or errors in the Obsidian status bar. Disable (kill-switch) to save system resources.",

  // GitHub connection
  "GitHub Connection Settings": "GitHub Connection Settings",
  "GitHub owner": "GitHub owner",
  "Enter your GitHub username or organization name": "Enter your GitHub username or organization name",
  "GitHub repo": "GitHub repo",
  "Enter your GitHub repository name": "Enter your GitHub repository name",
  "GitHub branch": "GitHub branch",
  "Enter your GitHub branch name (e.g., main)": "Enter your GitHub branch name (e.g., main)",
  "GitHub token": "GitHub token",
  "Personal Access Token used to access the GitHub API": "Personal Access Token used to access the GitHub API",
  "Enter your GitHub personal access token": "Enter your GitHub personal access token",
  "Remote repository name": "Remote repository name",

  // Sections
  "General Settings": "General Settings",
  "Encryption Settings": "Encryption Settings",
  "Manual & Force Operations": "Manual & Force Operations",
  "Automation & Exclusions": "Automation & Exclusions",
  "Support & Debug": "Support & Debug",

  // Debug / support
  "Copy debug information": "Copy debug information",
  "Copy debug information to the clipboard, may contain sensitive information!": "Copy debug information to the clipboard, may contain sensitive information!",
  "Open the console with the shortcut key to see this plugin's logs and other plugin logs.": "Open the console with the shortcut key to see this plugin's logs and other plugin logs.",
  "console_mac": "Cmd (⌘) + option (⌥) + i",
  "console_windows": "Ctrl (⌃) + shift (⇧) + i",
  "Donation": "Donation",
  "If you like this plugin, please consider donating to support continued development.": "If you like this plugin, please consider donating to support continued development.",
  "Buy me a coffee at ko-fi.com": "Buy me a coffee at ko-fi.com",

  // GitHub sync config (settings-view.tsx)
  "GitHub sync configuration": "GitHub sync configuration",
  "Sync using the GitHub API": "Sync using the GitHub API",
}

export default en;
