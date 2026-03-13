import type { Severity } from "../../shared/findings";
import taxonomy from "../../shared/cognitive_bias_trigger_taxonomy.json";

export interface TriggerTechniqueDef {
  label: string;
  description: string;
  cognitiveBias: string;
  terms: string[];
  severity: Severity;
}

export const TECHNIQUE_LABELS = taxonomy.techniques.map(
  (t) => t.label,
) as unknown as readonly [string, ...string[]];

export type TriggerTechniqueLabel = (typeof taxonomy.techniques)[number]["label"];

export const SUPPORTED_LABELS: string[] = taxonomy.techniques.map((t) => t.label);

const REGEX_TERMS: Record<string, string[]> = {
  Loaded_Language: [
    "outrage", "disgrace", "evil", "outrageous", "disgusting", "pathetic",
    "shameful", "shocking", "appalling", "despicable", "heroic", "glorious",
    "devastating", "alarming", "plague", "beacon", "nightmare", "catastrophe",
    "true american heroes", "worst abuses", "controversial interrogation program",
    "sold us out", "filthy compound",
    "horrifying details released", "terror compound",
  ],
  Name_Calling_Labeling: [
    "liberal elite", "far-right", "extremist", "radical left", "fascist",
    "communist", "puppet", "thug", "deplorable", "snowflake", "traitor",
    "clown", "lunatic", "crook", "fake news",
    "witch hunt", "mueller circus", "controlled opposition", "blue privilege",
  ],
  Repetition: [],
  Exaggeration_Minimisation: [
    "greatest", "worst ever", "best ever", "unprecedented", "historic",
    "trivial", "minor", "insignificant", "nothing burger", "big shake-up",
  ],
  Doubt: [
    "can we really trust", "remains to be seen", "so-called", "allegedly",
    "questionable", "suspicious", "self-proclaimed",
  ],
  Appeal_to_Fear_Prejudice: [
    "threat", "danger", "catastrophe", "crisis", "doom", "collapse",
    "if we don't act now", "our way of life", "irreversible",
    "will be destroyed", "existential threat", "global pandemic imminent",
  ],
  Flag_Waving: [
    "true patriot", "our nation", "our country", "un-american",
    "our values", "our people", "national pride", "homeland",
  ],
  Causal_Oversimplification: [
    "the only reason", "simply because", "all because of", "single-handedly",
    "is to blame", "that's why", "caused by",
  ],
  Slogans: [
  ],
  Appeal_to_Authority: [
    "experts say", "scientists agree", "studies show", "according to",
  ],
  Black_and_White_Fallacy: [
    "either", "or else", "the only choice", "the only way",
    "you're either with us", "no middle ground", "there is no alternative",
  ],
  Thought_Terminating_Cliches: [
    "it is what it is", "everything happens for a reason", "at the end of the day",
    "that's just how it is", "boys will be boys", "it's God's will",
  ],
  Whataboutism_Straw_Men_Red_Herring: [
    "what about", "but what about", "but look at", "the real issue is",
    "so you're saying", "they want us to believe",
  ],
  Bandwagon_Reductio_ad_Hitlerum: [
    "everyone knows", "most people", "millions of people", "the whole country",
    "everybody agrees", "just like Hitler", "just like the Nazis",
  ],
};

export const TECHNIQUES: TriggerTechniqueDef[] = taxonomy.techniques.map((t) => ({
  label: t.label,
  description: t.description,
  cognitiveBias: t.cognitiveBias,
  severity: t.severity as Severity,
  terms: REGEX_TERMS[t.label] ?? [],
}));

export const TIPS = [
  "Ask yourself: is this phrase trying to make me feel something instead of think something?",
  "Check whether the argument works without the emotionally loaded words.",
  "Consider what options are missing when only two extremes are presented.",
  "Notice when a claim relies on who said it rather than the evidence behind it.",
];

export const SIMPLE_REPLACEMENTS: Record<string, string> = {
  obviously: "it appears that",
  clearly: "the evidence suggests",
  undeniably: "arguably",
  outrageous: "noteworthy",
  shocking: "unexpected",
  disgusting: "objectionable",
  evil: "harmful",
  catastrophe: "serious situation",
  threat: "concern",
  crisis: "challenge",
  "the only way": "one approach",
  always: "often",
  never: "rarely",
  "everyone knows": "it is commonly held",
  "true patriot": "supporter",
};
