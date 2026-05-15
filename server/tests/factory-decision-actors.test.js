import { describe, it, expect } from 'vitest';
import {
  DECISION_STAGE_ACTORS,
  normalizeDecisionStage,
  getDecisionActor,
} from '../factory/decision-actors.js';

describe('decision-actors helpers (extracted from loop-controller)', () => {
  describe('DECISION_STAGE_ACTORS map', () => {
    it('covers the seven canonical stages + plan_review', () => {
      expect(Object.keys(DECISION_STAGE_ACTORS).sort()).toEqual(
        ['execute', 'learn', 'plan', 'plan_review', 'prioritize', 'sense', 'verify'].sort()
      );
    });

    it('is frozen', () => {
      expect(Object.isFrozen(DECISION_STAGE_ACTORS)).toBe(true);
    });

    it('maps each stage to its agent', () => {
      expect(DECISION_STAGE_ACTORS.sense).toBe('health_model');
      expect(DECISION_STAGE_ACTORS.prioritize).toBe('architect');
      expect(DECISION_STAGE_ACTORS.plan).toBe('planner');
      expect(DECISION_STAGE_ACTORS.plan_review).toBe('reviewer');
      expect(DECISION_STAGE_ACTORS.execute).toBe('executor');
      expect(DECISION_STAGE_ACTORS.verify).toBe('verifier');
      expect(DECISION_STAGE_ACTORS.learn).toBe('verifier');
    });
  });

  describe('normalizeDecisionStage', () => {
    it('lowercases recognized stage names', () => {
      expect(normalizeDecisionStage('SENSE')).toBe('sense');
      expect(normalizeDecisionStage('Prioritize')).toBe('prioritize');
      expect(normalizeDecisionStage('learn')).toBe('learn');
    });

    it('returns null for unknown stages', () => {
      expect(normalizeDecisionStage('idle')).toBeNull();
      expect(normalizeDecisionStage('starved')).toBeNull();
      expect(normalizeDecisionStage('not_a_stage')).toBeNull();
    });

    it('returns null for non-string / falsy inputs', () => {
      expect(normalizeDecisionStage(null)).toBeNull();
      expect(normalizeDecisionStage(undefined)).toBeNull();
      expect(normalizeDecisionStage('')).toBeNull();
      expect(normalizeDecisionStage(42)).toBeNull();
      expect(normalizeDecisionStage({})).toBeNull();
    });
  });

  describe('getDecisionActor', () => {
    it('prefers an explicit actor over the stage map', () => {
      expect(getDecisionActor('sense', 'human_operator')).toBe('human_operator');
    });

    it('falls back to the stage→actor map when actor is unset', () => {
      expect(getDecisionActor('SENSE')).toBe('health_model');
      expect(getDecisionActor('plan')).toBe('planner');
      expect(getDecisionActor('learn')).toBe('verifier');
    });

    it('returns null when stage is unknown and no actor specified', () => {
      expect(getDecisionActor('idle')).toBeNull();
      expect(getDecisionActor(null)).toBeNull();
    });

    it('honors an explicit actor even when stage is unknown', () => {
      expect(getDecisionActor('idle', 'custom_agent')).toBe('custom_agent');
    });
  });
});
