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

// Total questions in the session (default 4)
$totalWanted = isset($_GET['total']) ? (int) $_GET['total'] : (isset($_GET['per']) ? (int) $_GET['per'] : 4);
$totalWanted = max(1, min(20, $totalWanted));

// Specific topic IDs: ?ids=bydleni,prace
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

$pool = [];
$sessionTopicsMeta = [];
foreach ($pickedIds as $id) {
    $topic = $allTopics[$id];
    $qs = $topic['questions'] ?? [];
    if (!$qs) {
        continue;
    }
    $sessionTopicsMeta[$id] = [
        'id' => $id,
        'name' => $topic['name'],
        'count' => 0,
    ];
    foreach ($qs as $q) {
        $pool[] = [
            'topicId' => $id,
            'topic' => $topic['name'],
            'subtopic' => $q['subtopic'] ?? null,
            'question' => $q['question'],
        ];
    }
}

if (!$pool) {
    json_response(['error' => 'No questions for selected topics'], 400);
}

shuffle($pool);
$flatQuestions = array_slice($pool, 0, min($totalWanted, count($pool)));

foreach ($flatQuestions as $q) {
    $tid = $q['topicId'];
    if (isset($sessionTopicsMeta[$tid])) {
        $sessionTopicsMeta[$tid]['count'] += 1;
    }
}

$sessionTopics = array_values(array_filter(
    $sessionTopicsMeta,
    static fn(array $t): bool => ($t['count'] ?? 0) > 0,
));

json_response([
    'topics' => $sessionTopics,
    'questions' => $flatQuestions,
    'total' => count($flatQuestions),
    'mode' => $requestedIds ? 'selected' : 'random',
]);
