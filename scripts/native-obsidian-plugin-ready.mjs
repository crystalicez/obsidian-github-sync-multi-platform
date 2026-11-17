/**
 * Test-only CDP expression for the installed Obsidian recovery smoke.
 * Wait for Obsidian's own startup loader before requesting at most one
 * explicit plugin load. Never retry a failed or still-in-flight load.
 *
 * Evaluates ONLY in the verified disposable Obsidian profile/vault.
 */
export function buildNativePluginReadyExpression(pluginId) {
  return `(async()=>{
    const id=${JSON.stringify(pluginId)};
    const manager=app.plugins;
    if(!manager.isEnabled())await manager.setEnable(true);
    if(!manager.enabledPlugins.has(id))await manager.enablePluginAndSave(id);
    let manualLoadRequested=false;
    for(let attempt=0;attempt<40;attempt++){
      if(manager.plugins[id])return true;
      // Allow the native plugin manager to finish its normal startup load.
      // Never call loadPlugin twice for the same process during this probe.
      if(attempt>=3&&!manualLoadRequested
        &&manager.isEnabled()&&manager.manifests[id]
        &&!manager.loadingPluginId){
        manualLoadRequested=true;
        await manager.loadPlugin(id);
      }
      if(manager.plugins[id])return true;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    return !!manager.plugins[id];
  })()`
}
