const cloudUnsupportedTools = new Set([
  "publish_computer",
  "save_computer",
  "screenshot",
  "run_task",
  "create_volume",
]);

export const toolAvailable = (target, name) =>
  target !== "cloud" || !cloudUnsupportedTools.has(name);
