function filterToolsBrief(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description && t.description.length > 120
      ? t.description.substring(0, 117) + '...'
      : t.description || '',
  }));
}

function filterToolsFull(tools) {
  return tools;
}

module.exports = { filterToolsBrief, filterToolsFull };
