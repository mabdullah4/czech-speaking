<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

$dataPath = dirname(__DIR__) . '/assets/data/questions.json';
if (!is_readable($dataPath)) {
    json_response(['error' => 'questions.json missing'], 500);
}

$payload = json_decode((string) file_get_contents($dataPath), true);
if (!is_array($payload) || empty($payload['topics'])) {
    json_response(['error' => 'Invalid questions.json'], 500);
}

$allTopics = $payload['topics'];
$availableIds = array_keys($allTopics);

$questionsPerTopic = isset($_GET['per']) ? (int) $_GET['per'] : 4;
$questionsPerTopic = max(1, min(10, $questionsPerTopic));

// Specific topic IDs: ?ids=bydleni,prace  (comma-separated)
$requestedIds = [];
$idsParam = trim((string) ($_GET['ids'] ?? ''));
if ($idsParam !== '') {
    foreach (explode(',', $idsParam) as $raw) {
        $id = trim($raw);
        if ($id !== '' && isset($allTopics[$id])) {
            $requestedIds[] = $id;
        }
    }
    $requestedIds = array_values(array_unique($requestedIds));
}

if ($requestedIds) {
    $pickedIds = $requestedIds;
} else {
    $topicsWanted = isset($_GET['topics']) ? (int) $_GET['topics'] : 2;
    $topicsWanted = max(1, min(count($availableIds), $topicsWanted));
    $ids = $availableIds;
    shuffle($ids);
    $pickedIds = array_slice($ids, 0, $topicsWanted);
}

$sessionTopics = [];
$flatQuestions = [];

foreach ($pickedIds as $id) {
    $topic = $allTopics[$id];
    $pool = $topic['questions'] ?? [];
    if (!$pool) {
        continue;
    }
    shuffle($pool);
    $chosen = array_slice($pool, 0, min($questionsPerTopic, count($pool)));
    $sessionTopics[] = [
        'id' => $id,
        'name' => $topic['name'],
        'count' => count($chosen),
    ];
    foreach ($chosen as $q) {
        $flatQuestions[] = [
            'topicId' => $id,
            'topic' => $topic['name'],
            'subtopic' => $q['subtopic'] ?? null,
            'question' => $q['question'],
        ];
    }
}

if (!$flatQuestions) {
    json_response(['error' => 'No questions for selected topics'], 400);
}

json_response([
    'topics' => $sessionTopics,
    'questions' => $flatQuestions,
    'total' => count($flatQuestions),
    'mode' => $requestedIds ? 'selected' : 'random',
]);
