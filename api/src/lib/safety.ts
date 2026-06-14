import { z } from 'zod';
import { generateStructured } from './ai.js';

// A companion must know when to stop being clever. Two-stage detection:
// (1) a cheap keyword fast-path that can't miss the most acute cases, then
// (2) an LLM classifier for nuance. Either can escalate.

const CRISIS_PATTERNS =
  /\b(kill myself|end my life|suicide|suicidal|want to die|self[- ]?harm|hurt myself|no reason to live)\b/i;

const ClassifierOut = z.object({
  severity: z.number().int().min(0).max(3),
  signals: z.array(z.string()),
});

export interface SafetyResult {
  severity: 0 | 1 | 2 | 3;
  signals: string[];
}

export async function detectDistress(text: string): Promise<SafetyResult> {
  if (CRISIS_PATTERNS.test(text)) {
    return { severity: 3, signals: ['crisis_language'] };
  }
  try {
    const object = await generateStructured(ClassifierOut, {
      temperature: 0,
      system:
        'You are a careful safety classifier for a mindfulness app. Rate distress in the ' +
        'user text. 0 = none, 1 = mild low mood, 2 = elevated (hopelessness, severe anxiety), ' +
        '3 = crisis (self-harm/suicidal intent). Bias toward caution. Return signals as short tags.',
      prompt: text,
    });
    return { severity: object.severity as SafetyResult['severity'], signals: object.signals };
  } catch {
    // Fail safe: if the classifier errors, don't block the user, but don't
    // pretend it's fine either — mild flag so the UI can soften.
    return { severity: 1, signals: ['classifier_unavailable'] };
  }
}

// Region/language-aware crisis resources. Real deployment loads these from a
// maintained table; hard-coded here so the handoff path is demonstrably wired.
export function crisisResources(lang: 'en' | 'hi') {
  return {
    en: {
      message:
        "It sounds like you're carrying something heavy. You deserve real support — please reach out to someone who can help right now.",
      lines: [
        { name: 'iCall (India)', contact: '9152987821' },
        { name: 'AASRA', contact: '+91-9820466726' },
        { name: 'Intl. Assoc. for Suicide Prevention', contact: 'https://www.iasp.info/resources/Crisis_Centres/' },
      ],
    },
    hi: {
      message:
        'ऐसा लगता है कि आप कुछ भारी महसूस कर रहे हैं। आप असली सहारे के हक़दार हैं — कृपया अभी किसी से बात करें।',
      lines: [
        { name: 'iCall', contact: '9152987821' },
        { name: 'AASRA', contact: '+91-9820466726' },
      ],
    },
  }[lang];
}
