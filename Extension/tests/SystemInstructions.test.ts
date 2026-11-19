import { describe, expect, it } from 'vitest';
import { systemInstruction } from '../src/Generation/SystemInstructions';

const instruction = systemInstruction.toLowerCase();

describe('shared generation system instructions', () => {
  it('uses an answer-first policy for reasonably answerable questions', () => {
    expect(instruction).toContain('answer first');
    expect(instruction).toContain(
      'answer every question that can reasonably be answered'
    );
    expect(instruction).toContain('question text');
    expect(instruction).toContain('answer options');
    expect(instruction).toContain('settled context');
    expect(instruction).toContain('relevant general knowledge');
  });

  it('prefers best-supported answers over unnecessary abstention', () => {
    expect(instruction).toContain('best-supported answer');
    expect(instruction).toContain('some uncertainty remains');
    expect(instruction).toContain('do not abstain merely because');
    expect(instruction).toContain('not completely certain');
    expect(instruction).toContain('uncertainty alone');
  });

  it('allows reasonable answers to subjective questions', () => {
    expect(instruction).toContain('opinion, evaluation, or subjective');
    expect(instruction).toContain('reasonable response is possible');
    expect(instruction).toContain(
      'do not abstain solely because the question is subjective'
    );
  });

  it('forbids inventing personal information or pretending missing content is available', () => {
    expect(instruction).toContain('do not invent personal information');
    expect(instruction).toContain(
      'experiences, preferences, or facts about the respondent'
    );
    expect(instruction).toContain('never pretend to have access');
    expect(instruction).toContain('images, attachments, or context');
    expect(instruction).toContain('was not supplied');
  });

  it('allows abstention when images or essential context are missing', () => {
    expect(instruction).toContain('depends on an image, attachment');
    expect(instruction).toContain('lacks essential context');
    expect(instruction).toContain('essential information is missing');
    expect(instruction).toContain('no supplied choice');
  });

  it('defines distinct abstention reasons', () => {
    expect(instruction).toContain('low_confidence');
    expect(instruction).toContain(
      'no sufficiently supported answer can reasonably be selected'
    );
    expect(instruction).toContain('unable_to_determine');
    expect(instruction).toContain('essential information is missing or unavailable');
    expect(instruction).toContain('not_applicable');
    expect(instruction).toContain('question genuinely does not apply');
  });
});
