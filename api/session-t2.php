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

$byId = [];
foreach ($payload['dialogues'] as $d) {
    if (!is_array($d) || empty($d['id'])) {
        continue;
    }
    $byId[(string) $d['id']] = $d;
}

if (!$byId) {
    json_response(['error' => 'No dialogues available'], 500);
}

$requestedIds = [];
$idsParam = trim((string) ($_GET['ids'] ?? ''));
if ($idsParam !== '') {
    foreach (explode(',', $idsParam) as $raw) {
        $id = trim($raw);
        if ($id !== '' && isset($byId[$id])) {
            $requestedIds[] = $id;
        }
    }
    $requestedIds = array_values(array_unique($requestedIds));
}

$countWanted = isset($_GET['count']) ? (int) $_GET['count'] : 2;
$countWanted = max(1, min(4, $countWanted));

if ($requestedIds) {
    $pickedIds = array_slice($requestedIds, 0, $countWanted);
    // If user picked fewer than wanted, fill with random others
    if (count($pickedIds) < $countWanted) {
        $rest = array_values(array_diff(array_keys($byId), $pickedIds));
        shuffle($rest);
        $pickedIds = array_merge($pickedIds, array_slice($rest, 0, $countWanted - count($pickedIds)));
    }
} else {
    $ids = array_keys($byId);
    shuffle($ids);
    $pickedIds = array_slice($ids, 0, min($countWanted, count($ids)));
}

$sessionDialogues = [];
$turns = [];

foreach ($pickedIds as $dialogueIndex => $id) {
    $d = $byId[$id];
    $hints = array_values(array_map('strval', $d['hints'] ?? []));
    $models = array_values(array_map('strval', $d['model_questions'] ?? []));
    $replies = array_values(array_map('strval', $d['replies'] ?? []));
    $title = (string) ($d['title'] ?? $id);
    $situation = (string) ($d['situation'] ?? '');
    $opening = (string) ($d['opening'] ?? 'Dobrý den. Co pro vás můžu udělat?');
    $closing = (string) ($d['closing'] ?? 'Není zač.');
    $freeModel = (string) ($d['free_model'] ?? 'Můžu se ještě na něco zeptat?');
    $freeReply = (string) ($d['free_reply'] ?? 'Ano, to je možné.');

    // Ensure 3 hints
    while (count($hints) < 3) {
        $hints[] = 'Informace?';
    }
    $hints = array_slice($hints, 0, 3);
    while (count($models) < 3) {
        $models[] = 'Můžete mi prosím poradit?';
    }
    $models = array_slice($models, 0, 3);
    while (count($replies) < 3) {
        $replies[] = 'Ano, samozřejmě.';
    }
    $replies = array_slice($replies, 0, 3);

    $cardHints = array_merge($hints, ['…? (vaše otázka)']);

    $sessionDialogues[] = [
        'id' => $id,
        'title' => $title,
        'situation' => $situation,
        'hints' => $cardHints,
        'index' => $dialogueIndex,
    ];

    $turns[] = [
        'kind' => 'opening',
        'dialogueId' => $id,
        'dialogueTitle' => $title,
        'dialogueIndex' => $dialogueIndex,
        'situation' => $situation,
        'hints' => $cardHints,
        'text' => $opening,
        'hintIndex' => null,
    ];

    for ($i = 0; $i < 3; $i += 1) {
        $turns[] = [
            'kind' => 'ask',
            'dialogueId' => $id,
            'dialogueTitle' => $title,
            'dialogueIndex' => $dialogueIndex,
            'situation' => $situation,
            'hints' => $cardHints,
            'hint' => $hints[$i],
            'hintIndex' => $i,
            'isFree' => false,
            'model_question' => $models[$i],
            'reply' => $replies[$i],
        ];
    }

    $turns[] = [
        'kind' => 'ask',
        'dialogueId' => $id,
        'dialogueTitle' => $title,
        'dialogueIndex' => $dialogueIndex,
        'situation' => $situation,
        'hints' => $cardHints,
        'hint' => '…? (vaše otázka)',
        'hintIndex' => 3,
        'isFree' => true,
        'model_question' => $freeModel,
        'reply' => $freeReply,
    ];

    $turns[] = [
        'kind' => 'closing',
        'dialogueId' => $id,
        'dialogueTitle' => $title,
        'dialogueIndex' => $dialogueIndex,
        'situation' => $situation,
        'hints' => $cardHints,
        'text' => $closing,
        'hintIndex' => null,
    ];
}

$askCount = count(array_filter($turns, static fn(array $t): bool => ($t['kind'] ?? '') === 'ask'));

json_response([
    'task' => 2,
    'dialogues' => $sessionDialogues,
    'turns' => $turns,
    'totalAsks' => $askCount,
    'mode' => $requestedIds ? 'selected' : 'random',
]);
