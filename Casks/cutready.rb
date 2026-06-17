cask "cutready" do
  version :latest
  sha256 :no_check

  on_arm do
    url "https://github.com/sethjuarez/cutready/releases/latest/download/CutReady_aarch64.dmg"
  end
  on_intel do
    url "https://github.com/sethjuarez/cutready/releases/latest/download/CutReady_x64.dmg"
  end

  name "CutReady"
  desc "Desktop app for product demo video production"
  homepage "https://github.com/sethjuarez/cutready"

  livecheck do
    url "https://github.com/sethjuarez/cutready/releases/latest"
    strategy :github_latest
  end

  auto_updates true

  app "CutReady.app"

  zap trash: [
    "~/Library/Application Support/com.cutready.app",
    "~/Library/Caches/com.cutready.app",
    "~/Library/Logs/com.cutready.app",
    "~/Library/Preferences/com.cutready.app.plist",
    "~/Library/Saved Application State/com.cutready.app.savedState",
  ]
end
