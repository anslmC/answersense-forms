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

  it('requires abstention for missing respondent-specific personal information', () => {
    expect(instruction).toContain(
      'respondent-specific factual information that is not available'
    );
    expect(instruction).toContain('abstain instead of guessing');
    expect(instruction).toContain('full name');
    expect(instruction).toContain('student number');
    expect(instruction).toContain('course and year level');
    expect(instruction).toContain('section');
    expect(instruction).toContain('address');
    expect(instruction).toContain('contact information');
    expect(instruction).toContain('personal history or experiences');
  });

  it('forbids placeholders for missing personal information', () => {
    expect(instruction).toContain('never substitute placeholders');
    expect(instruction).toContain('n/a');
    expect(instruction).toContain('unknown');
    expect(instruction).toContain('not provided');
    expect(instruction).toContain('not applicable');
    expect(instruction).toContain('prefer not to say');
    expect(instruction).toContain(
      'supplied context explicitly establishes that they are appropriate responses'
    );
  });

  it('forbids inferring respondent identity or attributes from options', () => {
    expect(instruction).toContain(
      'never infer respondent identity or attributes'
    );
    expect(instruction).toContain(
      'supplied answer options do not establish which option applies'
    );
    expect(instruction).toContain('3cpe a');
    expect(instruction).toContain('3cpe b');
    expect(instruction).toContain("respondent's actual section");
    expect(instruction).toContain('list of names does not establish');
    expect(instruction).toContain(
      'do not select the most likely, common, or plausible option'
    );
  });

  it('requires explicit respondent information for selection questions', () => {
    expect(instruction).toContain(
      'respondent-specific selection questions must only be answered using explicit respondent information'
    );
    expect(instruction).toContain('year level');
    expect(instruction).toContain('department');
    expect(instruction).toContain('organization or affiliation');
    expect(instruction).toContain(
      'do not select an option unless the supplied context establishes which option applies'
    );
    expect(instruction).toContain(
      'available options are not evidence about the respondent'
    );
    expect(instruction).toContain('never assume the first option is correct');
    expect(instruction).toContain('choose the most common or likely option');
    expect(instruction).toContain(
      'guess simply because the question is multiple-choice'
    );
    expect(instruction).toContain('status abstained');
    expect(instruction).toContain('reason unable_to_determine');
    expect(instruction).toContain('answer null');
  });

  it('allows personal questions when explicit respondent information is supplied', () => {
    expect(instruction).toContain(
      'personal questions when the necessary information is explicitly available'
    );
    expect(instruction).toContain(
      'unless the supplied context establishes which option applies'
    );
  });

  it('keeps missing personal information distinct from ordinary uncertainty', () => {
    expect(instruction).toContain(
      'do not confuse missing personal information with ordinary uncertainty'
    );
    expect(instruction).toContain(
      'continue answering ordinary factual questions using general knowledge'
    );
    expect(instruction).toContain(
      'subjective questions when a reasonable answer can be provided'
    );
    expect(instruction).toContain('questions supported by supplied context');
    expect(instruction).toContain(
      'personal questions when the necessary information is explicitly available'
    );
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
    expect(instruction).toContain(
      'essential information is missing or unavailable'
    );
    expect(instruction).toContain('not_applicable');
    expect(instruction).toContain('question genuinely does not apply');
  });
});
