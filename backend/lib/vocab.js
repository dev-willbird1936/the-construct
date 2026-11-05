// Fixed candidate concepts used to fake "right-click anything" without a captioner
// (Muse Spark is intentionally not used). Broad on purpose -- people, animals,
// vehicles, objects, and environment/nature terms -- since there's no captioner
// to narrow the search to what's actually in frame. The free-text search box
// covers anything still missed.
export const CANDIDATE_CONCEPTS = [
  // people
  "person",
  "face",
  "hand",
  "child",
  "crowd",
  // animals
  "dog",
  "cat",
  "bird",
  "fish",
  "horse",
  "cow",
  "deer",
  "elephant",
  "lion",
  "bear",
  "rabbit",
  "insect",
  "animal",
  // vehicles
  "car",
  "truck",
  "bicycle",
  "motorcycle",
  "bus",
  "boat",
  "airplane",
  "train",
  // objects / furniture
  "chair",
  "table",
  "sofa",
  "bed",
  "lamp",
  "bottle",
  "cup",
  "plate",
  "book",
  "phone",
  "laptop",
  "television",
  "clock",
  "box",
  "bag",
  "backpack",
  "umbrella",
  "ball",
  "toy",
  // clothing
  "hat",
  "shoe",
  "jacket",
  "glasses",
  // environment / nature
  "tree",
  "flower",
  "grass",
  "rock",
  "mountain",
  "water",
  "cloud",
  "sun",
  "snow",
  "building",
  "house",
  "door",
  "window",
  "road",
  "bridge",
  "fence",
  "sign",
  "food",
];

// What "the subject" can be when the app picks for you: things that move or get handled,
// not the scenery around them (trees, water, buildings, ...) or parts of a body.
const NOT_SUBJECT = new Set([
  "face", "hand", "hat", "shoe", "jacket", "glasses", "flower", "grass", "rock", "mountain", "water", "cloud",
  "sun", "snow", "building", "house", "door", "window", "road", "bridge", "fence", "sign", "tree", "food",
  "table", "chair", "sofa", "bed", "lamp", "television", "clock",
]);
export const SUBJECT_CONCEPTS = CANDIDATE_CONCEPTS.filter((c) => !NOT_SUBJECT.has(c));

// The few broad concepts the auto-pick sweeps over several moments of a clip.
export const AUTO_CONCEPTS = ["person", "animal", "vehicle"];

export const DETECT_CONCURRENCY = 8;
