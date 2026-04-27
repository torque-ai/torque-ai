'use strict';

const SQL = `
  SELECT s.name, s.kind, s.file_path AS file, s.start_line AS line
  FROM cg_symbols s
  WHERE s.repo_path = @repoPath
    AND NOT EXISTS (
      SELECT 1 FROM cg_references r
      WHERE r.repo_path = s.repo_path AND r.target_name = s.name
    )
  ORDER BY s.file_path, s.start_line
`;

function deadSymbols({ db, repoPath }) {
  return db.prepare(SQL).all({ repoPath });
}

module.exports = { deadSymbols };
