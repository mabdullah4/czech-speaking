<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

$dataPath = dirname(__DIR__) . '/assets/data/dialogues.json';
if (!is_readable($dataPath)) {
    json_response(['error' => 'dialogues.json missing'], 500);
}

$payload = json_decode((string) file_get_contents($dataPath), true);
if (!is_array($payload) || empty($payload['dialogues']) || !is_array($payload['dialogues'])) {
    json_response(['error' => 'Invalid dialogues.json'], 500);
}

$dialogues = [];
foreach ($payload['dialogues'] as $d) {
    if (!is_array($d) || empty($d['id'])) {
        continue;
    }
    $dialogues[] = [
        'id' => (string) $d['id'],
        'title' => (string) ($d['title'] ?? $d['id']),
        'situation' => (string) ($d['situation'] ?? ''),
        'hints' => array_values(array_map('strval', $d['hints'] ?? [])),
    ];
}

json_response(['dialogues' => $dialogues]);
