{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22; # >= 22.18 for TypeScript type stripping and node:sqlite
    npm.enable = true;
  };

  packages = with pkgs; [
    git
    chromium # `npm run shoot` drives this directly; nothing is ever downloaded
    playwright-driver.browsers
  ];

  # The browser comes from nix, never from npm's postinstall.
  env = {
    CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
    PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };

  # .env holds FACTORY_PASSWORD and FACTORY_HOOK_TOKEN, which `npm run shoot` needs.
  dotenv.enable = true;

  enterShell = ''
    echo "swfactory — node $(node --version), chromium $(chromium --version | cut -d' ' -f2)"
    echo "  npm test | npm run typecheck | npm run shoot | npm run dev"
  '';
}
