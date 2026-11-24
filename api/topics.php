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

$topics = [];
foreach ($payload['topics'] as $id => $topic) {
    $topics[] = [
        'id' => $id,
        'name' => $topic['name'],
        'count' => count($topic['questions'] ?? []),
    ];
}

json_response(['topics' => $topics]);
