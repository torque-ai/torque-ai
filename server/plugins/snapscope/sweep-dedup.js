'use strict';

const GLOBAL_THRESHOLD = 3;

function buildFindingSignature(finding) {
  const safeFinding = finding && typeof finding === 'object' ? finding : {};

  return [
    safeFinding.check || '',
    safeFinding.element_type || '',
    safeFinding.automation_id || '',
    safeFinding.element_name || '',
  ].join(':');
}

function deduplicateFindings(perSection) {
  if (!perSection || typeof perSection !== 'object' || Array.isArray(perSection)) {
    return {
      global_findings: [],
      per_section: {},
    };
  }

  const signatureToSections = new Map();
  const signatureToFinding = new Map();

  for (const [sectionId, sectionData] of Object.entries(perSection)) {
    const findings = Array.isArray(sectionData?.findings) ? sectionData.findings : [];
    const sectionSignatures = new Set();

    for (const finding of findings) {
      const signature = buildFindingSignature(finding);
      sectionSignatures.add(signature);

      if (!signatureToFinding.has(signature)) {
        signatureToFinding.set(signature, finding);
      }
    }

    for (const signature of sectionSignatures) {
      if (!signatureToSections.has(signature)) {
        signatureToSections.set(signature, new Set());
      }

      signatureToSections.get(signature).add(sectionId);
    }
  }

  const globalSignatures = new Set();
  const globalFindings = [];

  for (const [signature, sections] of signatureToSections.entries()) {
    if (sections.size < GLOBAL_THRESHOLD) {
      continue;
    }

    globalSignatures.add(signature);
    globalFindings.push({
      signature,
      sections_affected: sections.size,
      finding: signatureToFinding.get(signature),
    });
  }

  const perSectionResult = {};

  for (const [sectionId, sectionData] of Object.entries(perSection)) {
    const findings = Array.isArray(sectionData?.findings) ? sectionData.findings : [];
    const flaggedElements = Array.isArray(sectionData?.flagged_elements)
      ? sectionData.flagged_elements
      : [];

    const uniqueFindingList = findings.filter(
      (finding) => !globalSignatures.has(buildFindingSignature(finding))
    );
    const uniqueFlaggedElements = flaggedElements.filter(
      (element) => !globalSignatures.has(buildFindingSignature(element))
    );

    perSectionResult[sectionId] = {
      stats: sectionData?.stats,
      unique_findings: uniqueFindingList.length,
      unique_finding_list: uniqueFindingList,
      flagged_elements: uniqueFlaggedElements,
      needs_llm: uniqueFindingList.length > 0 || uniqueFlaggedElements.length > 0,
    };
  }

  return {
    global_findings: globalFindings,
    per_section: perSectionResult,
  };
}

module.exports = {
  GLOBAL_THRESHOLD,
  buildFindingSignature,
  deduplicateFindings,
};
