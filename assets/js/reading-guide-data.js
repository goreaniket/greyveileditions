// The Greyveil connection map is public editorial metadata, NOT a replacement for the Supabase access catalog.
// Existing purchase prices, permissions and reader entitlement are authoritative in Supabase.
export const VOLUMES = [
  {
    "number": 1,
    "heading": "Volume I",
    "name": "The Human Paradox Collection",
    "description": "The inner journey: emotions and mental patterns, paradoxes of awareness, and the stories that shape the self.",
    "series": [
      "human-mind",
      "human-paradox",
      "human-fiction"
    ]
  },
  {
    "number": 2,
    "heading": "Volume II",
    "name": "The Human Experience",
    "description": "The lived journey: love, responsibility, unfair outcomes, digital noise, communication and the pursuit of enough.",
    "series": [
      "human-experience"
    ]
  }
];
export const SERIES = [
  {
    "slug": "human-mind",
    "name": "The Human Mind",
    "step": "Notice",
    "volume": 1
  },
  {
    "slug": "human-paradox",
    "name": "The Human Paradox",
    "step": "Question",
    "volume": 1
  },
  {
    "slug": "human-fiction",
    "name": "The Human Fiction",
    "step": "Examine",
    "volume": 1
  },
  {
    "slug": "human-experience",
    "name": "The Human Experience",
    "step": "Live",
    "volume": 2
  }
];
export const BOOKS = [
  {
    "position": 1,
    "series": "human-mind",
    "slug": "the-last-shift",
    "title": "The Last Shift",
    "question": "Why does attachment reshape the way we experience distance and loss?",
    "tags": [
      "Attachment",
      "Relationships",
      "Emotional exhaustion"
    ],
    "focus": "Attachment, emotional distance and detachment bring attention toward inner shifts.",
    "bridge": "Those shifts raise questions about the stories the mind tells.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 2,
    "series": "human-mind",
    "slug": "the-last-shift-ii",
    "title": "The Last Shift — Part II",
    "question": "How does the mind transform interpretations into personal reality?",
    "tags": [
      "Identity",
      "Perception",
      "Overthinking"
    ],
    "focus": "Distortion, interpretation, rejection, identity and awareness.",
    "bridge": "After recognising internal narration, consider the silence it can leave behind.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 3,
    "series": "human-mind",
    "slug": "the-quiet-i-started-living-with",
    "title": "The Quiet I Started Living With",
    "question": "What happens when there are feelings we cannot explain to anyone?",
    "tags": [
      "Loneliness",
      "Overthinking",
      "Emotional exhaustion"
    ],
    "focus": "Silence, internal isolation, unspoken feelings and the changing sense of self.",
    "bridge": "Within silence, unfinished thoughts can begin to repeat.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 4,
    "series": "human-mind",
    "slug": "the-loop-within",
    "title": "The Loop Within",
    "question": "Why do memories and unfinished conversations keep returning?",
    "tags": [
      "Overthinking",
      "Memory",
      "Attachment"
    ],
    "focus": "Emotional loops, reconstructing reality, repeated conversations and letting go.",
    "bridge": "Examining personal patterns makes room to consider other people's perspectives.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 5,
    "series": "human-mind",
    "slug": "when-understanding-begins",
    "title": "When Understanding Begins",
    "question": "Why do people who love each other still misunderstand each other?",
    "tags": [
      "Family",
      "Relationships",
      "Communication"
    ],
    "focus": "Parents, children, expectations, fear and understanding across emotional differences.",
    "bridge": "Understanding others opens the question of understanding ourselves.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 6,
    "series": "human-paradox",
    "slug": "the-paradox-of-awareness",
    "title": "The Paradox of Awareness",
    "question": "What happens when awareness starts questioning what it believed?",
    "tags": [
      "Awareness",
      "Identity",
      "Overthinking"
    ],
    "focus": "The burden of awareness, identity, control and the limits of certainty.",
    "bridge": "Greater awareness can generate a stronger need for explanations.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 7,
    "series": "human-paradox",
    "slug": "the-paradox-of-explanation",
    "title": "The Paradox of Explanation",
    "question": "Why do we keep needing reasons for every experience?",
    "tags": [
      "Meaning",
      "Uncertainty",
      "Perception"
    ],
    "focus": "The compulsion to explain, search for certainty and interpret uncertainty.",
    "bridge": "Question the mechanism of interpretation itself.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 8,
    "series": "human-paradox",
    "slug": "the-end-of-interpretation",
    "title": "The End of Interpretation",
    "question": "What changes when experience no longer needs a running explanation?",
    "tags": [
      "Awareness",
      "Meaning",
      "Identity"
    ],
    "focus": "The breakdown of narration, meaning-making and the central observer.",
    "bridge": "From interpretation, move to the nature of what we call reality.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 9,
    "series": "human-paradox",
    "slug": "the-paradox-of-reality",
    "title": "The Paradox of Reality",
    "question": "How much does memory and perception shape our sense of reality?",
    "tags": [
      "Perception",
      "Memory",
      "Uncertainty"
    ],
    "focus": "Invisible perceptual filters, subjective worlds and weakened certainty.",
    "bridge": "When certainty weakens, the mind's search for a final answer becomes visible.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 10,
    "series": "human-paradox",
    "slug": "the-paradox-of-stillness",
    "title": "The Paradox of Stillness",
    "question": "Why do we keep treating life as something not yet complete?",
    "tags": [
      "Meaning",
      "Enough",
      "Awareness"
    ],
    "focus": "The search for arrival, the thought of incompleteness and ordinary life continuing.",
    "bridge": "Instead of searching for another answer, investigate the one who searches.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 11,
    "series": "human-fiction",
    "slug": "the-fiction-of-awareness",
    "title": "The Fiction of Awareness",
    "question": "How does thought assemble a continuous story called 'me'?",
    "tags": [
      "Identity",
      "Awareness",
      "Memory"
    ],
    "focus": "Narration, memory, inner voice and how identity is repeatedly constructed.",
    "bridge": "Question the meaning assigned to the events of that self-story.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 12,
    "series": "human-fiction",
    "slug": "the-fiction-of-meaning",
    "title": "The Fiction of Meaning",
    "question": "Why do events become signs, lessons and personal stories?",
    "tags": [
      "Meaning",
      "Perception",
      "Identity"
    ],
    "focus": "Invented significance, symbolic explanations and the story-making mind.",
    "bridge": "Those stories extend into an imagined future version of ourselves.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 13,
    "series": "human-fiction",
    "slug": "the-fiction-of-becoming",
    "title": "The Fiction of Becoming",
    "question": "Why does an imagined future self make today seem insufficient?",
    "tags": [
      "Enough",
      "Identity",
      "Achievement"
    ],
    "focus": "Future-self projections, comparison, growth narratives and achievement identity.",
    "bridge": "From the future self, examine the wider story of being human.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 14,
    "series": "human-fiction",
    "slug": "the-fiction-of-human",
    "title": "The Fiction of the Human",
    "question": "What remains when the familiar story of being human is questioned?",
    "tags": [
      "Identity",
      "Meaning",
      "Awareness"
    ],
    "focus": "A synthesis of self, meaning, becoming and the idea of separateness.",
    "bridge": "Philosophical investigation gives way to the complexity of ordinary lived life.",
    "volume": 1,
    "status": "existing_catalog"
  },
  {
    "position": 15,
    "series": "human-experience",
    "slug": "the-person-who-was-tired-of-being-strong",
    "title": "The Person Who Was Tired of Being Strong",
    "question": "What hides behind a life of always seeming strong?",
    "tags": [
      "Emotional exhaustion",
      "Identity",
      "Enough"
    ],
    "focus": "Approval, buried needs, emotional numbness and accepting one's reality.",
    "bridge": "The world we experience is influenced by what we assume about it.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 16,
    "series": "human-experience",
    "slug": "the-world-we-thought-we-saw",
    "title": "The World We Thought We Saw",
    "question": "How do perception and memory change the world we believe we know?",
    "tags": [
      "Perception",
      "Memory",
      "Relationships"
    ],
    "focus": "Assumptions, mental filters and the personal worlds built around events.",
    "bridge": "Those filters grow more complex when love and another person are involved.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 17,
    "series": "human-experience",
    "slug": "an-unknown-part-of-life",
    "title": "An Unknown Part of Life",
    "question": "What can love, jealousy, sacrifice and fear reveal about attachment?",
    "tags": [
      "Relationships",
      "Attachment",
      "Uncertainty"
    ],
    "focus": "Romance, compatibility, betrayal, expectations and emotional contradictions.",
    "bridge": "Love raises a harder question: when does care turn into wanting to save someone?",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 18,
    "series": "human-experience",
    "slug": "the-people-we-couldnt-save",
    "title": "The People We Couldn't Save",
    "question": "When can helping another person become part of our identity?",
    "tags": [
      "Relationships",
      "Responsibility",
      "Loss"
    ],
    "focus": "Rescuing, usefulness, guilt, responsibility and boundaries.",
    "bridge": "Care and loss belong to a wider life shaped by time and human limits.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 19,
    "series": "human-experience",
    "slug": "between-birth-and-death",
    "title": "Between Birth and Death",
    "question": "What happens to a person across the entire movement of a life?",
    "tags": [
      "Life",
      "Identity",
      "Loss"
    ],
    "focus": "Childhood, ageing, identity, responsibility, attachment and mortality.",
    "bridge": "The shape of a life depends not only on choices, but on uncontrollable outcomes.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 20,
    "series": "human-experience",
    "slug": "the-things-we-did-right-and-still-lost",
    "title": "The Things We Did Right and Still Lost",
    "question": "Why can doing the right things still lead to loss?",
    "tags": [
      "Loss",
      "Uncertainty",
      "Responsibility"
    ],
    "focus": "Effort, chance, unfair outcomes, persistence and disappointment.",
    "bridge": "In trying to build a better future, we can overlook the life being lived.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 21,
    "series": "human-experience",
    "slug": "the-life-we-forgot-while-building-a-life",
    "title": "The Life We Forgot While Building a Life",
    "question": "What gets postponed while we keep trying to build a life?",
    "tags": [
      "Responsibility",
      "Emotional exhaustion",
      "Achievement"
    ],
    "focus": "Work, caregiving, duty, productivity and neglected presence.",
    "bridge": "The wider world adds another layer of constant demands and comparisons.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 22,
    "series": "human-experience",
    "slug": "the-world-that-never-leaves-us-alone",
    "title": "The World That Never Leaves Us Alone",
    "question": "What happens when information and other people's lives never stop reaching us?",
    "tags": [
      "Digital overwhelm",
      "Perception",
      "Enough"
    ],
    "focus": "Digital exposure, comparison, information overload and borrowed experiences.",
    "bridge": "Seeing more of someone's life is not the same as understanding their mind.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 23,
    "series": "human-experience",
    "slug": "the-distance-between-two-minds",
    "title": "The Distance Between Two Minds",
    "question": "Can anyone completely understand another person's internal experience?",
    "tags": [
      "Communication",
      "Relationships",
      "Loneliness"
    ],
    "focus": "Language, empathy, misunderstanding and the limits of sharing an experience.",
    "bridge": "Even greater understanding cannot promise a final feeling of completion.",
    "volume": 2,
    "status": "manuscript_preview"
  },
  {
    "position": 24,
    "series": "human-experience",
    "slug": "the-enough-that-never-arrived",
    "title": "The Enough That Never Arrived",
    "question": "Why does feeling 'enough' move away after an achievement arrives?",
    "tags": [
      "Enough",
      "Achievement",
      "Meaning"
    ],
    "focus": "Adaptation, satisfaction, moving goals and life beyond anticipated arrival.",
    "bridge": "An open ending: experience continues without a final permanent state of enough.",
    "volume": 2,
    "status": "manuscript_preview"
  }
];
