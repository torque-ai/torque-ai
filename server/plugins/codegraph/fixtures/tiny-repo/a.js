function alpha() { return beta(); }
function gamma() { return alpha(); }
module.exports = { alpha, gamma };
