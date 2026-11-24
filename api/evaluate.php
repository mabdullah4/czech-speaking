<?php
declare(strict_types=1);

require __DIR__ . '/config.php';
require_api_key();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$question = trim((string) ($input['question'] ?? ''));
$answer = trim((string) ($input['answer'] ?? ''));

if ($question === '' || $answer === '') {
    json_response(['error' => 'Missing question or answer'], 400);
}

$prompt = "You are a strict Czech A2 oral-exam examiner (permanent residence).\n"
    . "Grade the learner answer. Feedback note must be in English and name the problem if any.\n"
    . "Rules: one full sentence; must make sense for THIS question. "
    . "Score 4–5 ONLY if on-topic AND a clear full sentence. "
    . "Yes/no alone, off-topic, or fragments = max 2–3.\n\n"
    . "Question: {$question}\n"
    . "Learner answer: {$answer}\n\n"
    . 'Return JSON: {"ok":true|false,"score":1-5,"note":"short English feedback","better":"model Czech sentence or null"}';

$result = gemini_interactions_failover($GOOGLE_API_KEYS, [
    'model' => $LISTEN_MODEL,
    'system_instruction' => 'Strict A2 Czech speaking grader. Notes in English. JSON only.',
    'input' => $prompt,
    'generation_config' => [
        'thinking_level' => 'low',
        'max_output_tokens' => 256,
    ],
], 60);

if (!$result['ok']) {
    json_response(['error' => $result['error'] ?? 'Evaluate failed'], 502);
}

$feedback = gemini_extract_json_object($result['data']);
if (!is_array($feedback)) {
    $raw = gemini_walk_extract_text($result['data']);
    json_response([
        'ok' => true,
        'score' => 3,
        'note' => $raw ?: 'Hotovo.',
        'better' => null,
    ]);
}

json_response([
    'ok' => (bool) ($feedback['ok'] ?? true),
    'score' => (int) ($feedback['score'] ?? 3),
    'note' => (string) ($feedback['note'] ?? ''),
    'better' => $feedback['better'] ?? null,
]);
