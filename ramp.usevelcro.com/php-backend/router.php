<?php

declare(strict_types=1);

/**
 * Minimal HTTP router for shared-hosting PHP.
 */
class Router
{
    /** @var array<int,array{method:string,pattern:string,callback:callable}> */
    private array $routes = [];

    public function get(string $pattern, callable $callback): void
    {
        $this->add('GET', $pattern, $callback);
    }

    public function post(string $pattern, callable $callback): void
    {
        $this->add('POST', $pattern, $callback);
    }

    public function patch(string $pattern, callable $callback): void
    {
        $this->add('PATCH', $pattern, $callback);
    }

    public function add(string $method, string $pattern, callable $callback): void
    {
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'callback' => $callback,
        ];
    }

    public function dispatch(string $method, string $path): bool
    {
        $method = strtoupper($method);
        $path = parse_url($path, PHP_URL_PATH) ?: $path;
        $path = rtrim($path, '/') ?: '/';

        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }
            $pattern = '#^' . $route['pattern'] . '$#';
            if (preg_match($pattern, $path, $matches)) {
                array_shift($matches);
                $args = array_values($matches);
                call_user_func_array($route['callback'], $args);
                return true;
            }
        }
        return false;
    }
}
