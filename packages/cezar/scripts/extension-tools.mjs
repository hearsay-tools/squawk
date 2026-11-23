/** Register the shared Squawk tool shape in the Pi and OMP extension APIs. */
export function registerExtensionTools(pi, tools) {
  for (const tool of tools) {
    pi.registerTool({
      name: tool.definition.name,
      label: tool.label,
      description: tool.definition.description,
      parameters: tool.definition.inputSchema,
      async execute(_toolCallId, params) { return tool.invoke(params); },
    });
  }
}
