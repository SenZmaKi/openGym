{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  importNpmLock,
  version,
}:

buildNpmPackage rec {
  pname = "opengym-mcp";
  inherit version;

  src = ./../../mcp;

  # The MCP server reads shared domain helpers from the sibling frontend/src/lib; include them.
  frontendSrc = ./../../frontend;
  apiSpec = ./../../api/openapi.yaml;

  nodejs = nodejs_22;

  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;

  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/opengym-mcp
    cp -r node_modules $out/lib/opengym-mcp/
    cp -r src $out/lib/opengym-mcp/

    # The MCP server imports shared training/domain helpers from ../../frontend/src/lib
    # (history, exercises, muscles, onerm, progression, workout-model, format, …). They are
    # resolved relative to $out/lib/opengym-mcp/src, so they must sit at $out/lib/frontend/src/lib.
    mkdir -p $out/lib/frontend/src
    cp -r $frontendSrc/src/lib $out/lib/frontend/src/lib

    # API operation discovery reads the same contract shipped with the server.
    mkdir -p $out/lib/api
    cp $apiSpec $out/lib/api/openapi.yaml

    mkdir -p $out/bin
    makeWrapper ${nodejs_22}/bin/node $out/bin/opengym-mcp \
      --add-flags "$out/lib/opengym-mcp/src/index.js"
    runHook postInstall
  '';

  meta = with lib; {
    description = "openGym MCP server — stdio analytics and authenticated API bridge for LLM clients";
    homepage = "https://gitlab.com/DuarteSantos8/opengym";
    license = licenses.agpl3Plus;
    platforms = nodejs.meta.platforms;
  };
}
