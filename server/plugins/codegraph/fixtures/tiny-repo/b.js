function beta() { return 1; }
function delta() { return beta(); }
module.exports = { beta, delta };
