  // Agent Ring controls for Custom.
  ringAlerts(t) {
    const key = "agent-ring.alerts";
    const prefs = shared(key) ?? {};
    const set = (name, value) => setShared(key, { ...(shared(key) ?? {}), [name]: value });
    const fixed = prefs.mode === "fixed";
    const soundScript = `${appHome()}/mods/agent-ring-toast/sound.cjs`;
    const play = (kind) => exec("node", [soundScript, kind, fixed ? "fixed" : "random", "", prefs[kind] ?? ""]);
    const toggle = (name, label) => this.row(t, label, "", this.toggle(t, `ring-${name}`, prefs[name] !== false, () => set(name, prefs[name] === false)));
    const track = (kind, label, fallback) => this.row(t, label, fixed ? (prefs[kind] ?? fallback) : "Per agent", h_flex().gap(8)
      .when(fixed, el => el.child(this.button(t, `ring-${kind}-next`, "Next track", async () => {
        const result = await exec("node", [soundScript, kind, "list"]);
        if (result.code !== 0) return;
        const files = JSON.parse(result.stdout);
        if (files.length) set(kind, files[(files.indexOf((shared(key) ?? {})[kind] ?? fallback) + 1) % files.length]);
      })))
      .child(this.button(t, `ring-${kind}-play`, "Play", () => play(kind))));
    return v_flex().w_full()
      .child(this.heading(t, "Agent Ring"))
      .child(toggle("banner", "macOS banners"))
      .child(this.row(t, "Notify for the focused pane", "Also alert when the agent you are watching finishes or needs you.",
        this.toggle(t, "ring-focused-pane", prefs.focusedPane === true, () => set("focusedPane", prefs.focusedPane !== true))))
      .child(toggle("sound", "Play agent sounds"))
      .child(this.row(t, "Sound selection", "Random assigns a sound to each agent pane.",
        this.button(t, "ring-mode", fixed ? "Fixed" : "Random per agent", () => set("mode", fixed ? "random" : "fixed"))))
      .child(this.row(t, "Sound library", `${appHome()}/mods/agent-ring-toast/sound-fx/`, ""))
      .child(track("done", "Agent finished", "whatthedogdoin.mp3"))
      .child(track("suspended", "Agent needs you", "error.mp3"));
  }
